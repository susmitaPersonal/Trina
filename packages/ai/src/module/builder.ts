import { checkSafety, isMostlyEnglish, safetyReason, stricter, type CompileIssue, type ModuleDefinitionInput, type ModuleIntent, type SafetyReport } from '@trina/contracts';
import { compileModule, defaultRegistry, moduleTexts, RESERVED_MODULE_IDS, type ModuleRegistry } from '@trina/engine';
import { extractJson } from '../intent/schema';
import { moduleDescribeMessages, moduleIntentMessages, PROMPT_VERSIONS, repairMessages } from '../prompts';
import type { LLMProvider, Locality } from '../provider';
import { TemplateProvider } from '../providers/template';
import { compileModuleIntent } from './compile-module-intent';
import { buildModuleIntentJsonSchema, checkModuleIntent } from './intent-schema';
import { templateModuleIntent } from './template';

export const MODULE_MAX_REPAIR_ATTEMPTS = 2;

export type ModuleDraftResult = {
  status: 'ok' | 'refused' | 'english_only';
  /** Human-readable reason when refused (deterministic safety finding) or English-only. */
  refusal: string | null;
  intent: ModuleIntent | null;
  definition: ModuleDefinitionInput | null;
  issues: CompileIssue[];
  risk: SafetyReport;
  notes: string[];
  provider: { id: string; modelId: string; locality: Locality };
  promptVersion: string;
  attempts: number;
  usedFallback: boolean;
  latencyMs: number;
  rawOutput: string;
};

export type ModuleDraftOptions = { ownerSeed: string; dateKey: string; registry?: ModuleRegistry; signal?: AbortSignal; describe?: boolean };

/**
 * The AI Module Builder (design §5): deterministic pre-safety → English check → constrained
 * ModuleIntent (enums only) → repair loop (≤ 2) → template fallback → deterministic module compiler →
 * engine validation → deterministic safety (monotonic) → optional description text (number guard).
 * Nothing the model writes can set points, thresholds, ids, speeds or verification levels.
 */
export async function createModuleDraft(provider: LLMProvider, prompt: string, opts: ModuleDraftOptions): Promise<ModuleDraftResult> {
  const started = Date.now();
  const registry = opts.registry ?? defaultRegistry;
  const notes: string[] = [];
  const base = {
    intent: null,
    definition: null,
    issues: [] as CompileIssue[],
    notes,
    provider: { id: provider.id, modelId: provider.modelId, locality: provider.capabilities.locality },
    promptVersion: PROMPT_VERSIONS.moduleIntent,
    attempts: 0,
    usedFallback: false,
    rawOutput: '',
  };

  // 1. Deterministic pre-safety on the raw prompt (any language): refuse before any model runs.
  const pre = checkSafety([prompt]);
  if (pre.level === 'blocked') {
    return { ...base, status: 'refused', refusal: `This activity isn't safe to turn into a challenge: ${safetyReason(pre)}.`, risk: pre, latencyMs: Date.now() - started };
  }
  // 2. English-only builder input (owner decision 2026-10-11).
  if (!isMostlyEnglish(prompt)) {
    return { ...base, status: 'english_only', refusal: 'The module builder understands English for now. Please describe the activity in English.', risk: pre, latencyMs: Date.now() - started };
  }

  // 3. Constrained generation with a repair loop.
  let intent: ModuleIntent | null = null;
  let raw = '';
  let attempts = 0;
  let used: LLMProvider = provider;
  if (provider.capabilities.locality !== 'none') {
    const baseMsgs = moduleIntentMessages(prompt, registry);
    let messages = baseMsgs;
    while (attempts <= MODULE_MAX_REPAIR_ATTEMPTS && !intent) {
      attempts++;
      try {
        const out = await provider.generate({ messages, schema: buildModuleIntentJsonSchema(), maxTokens: 600, temperature: 0.2, purpose: PROMPT_VERSIONS.moduleIntent, signal: opts.signal });
        raw = out.text;
        let parsed: unknown;
        try {
          parsed = extractJson(raw);
        } catch (e) {
          messages = repairMessages(raw, [(e as Error).message], baseMsgs);
          continue;
        }
        const check = checkModuleIntent(parsed);
        if (check.ok) intent = check.intent;
        else messages = repairMessages(raw, check.errors, baseMsgs);
      } catch (e) {
        notes.push(`AI model unavailable (${(e as Error).message}); used the built-in templates instead.`);
        break;
      }
    }
  }
  // 4. Fallback: keyword templates (deterministic).
  let usedFallback = false;
  if (!intent) {
    usedFallback = true;
    used = new TemplateProvider();
    if (provider.capabilities.locality !== 'none' && !notes.length) notes.push('The AI answer was not usable; started from a template you can edit.');
    const check = checkModuleIntent(templateModuleIntent(prompt));
    if (!check.ok) throw new Error(`Template fallback produced an invalid intent: ${check.errors.join(', ')}`);
    intent = check.intent;
  }
  if (intent.unresolved.includes('activity_unclear')) notes.push('We started from a general outdoor-play template; rename it and adjust the tasks.');

  // 5. Deterministic compiler (+ notes from the prompt, monotonic).
  let definition = compileModuleIntent({ ...intent, concerns: [...new Set([...intent.concerns, ...pre.concerns])] }, { ownerSeed: opts.ownerSeed, dateKey: opts.dateKey, extraNotes: pre.notes });

  // 6. Optional description text from the model: short, no numbers, must stay safe.
  if (opts.describe !== false && used.capabilities.locality !== 'none') {
    try {
      const out = await used.generate({ messages: moduleDescribeMessages(definition), maxTokens: 120, temperature: 0.4, purpose: PROMPT_VERSIONS.moduleDescribe, signal: opts.signal });
      const text = out.text.trim().replace(/^"|"$/g, '').slice(0, 300);
      if (text.length >= 20 && !/\d/.test(text) && !/https?:|www\./i.test(text) && checkSafety([text]).level !== 'blocked') definition = { ...definition, meta: { ...definition.meta!, description: text } };
    } catch {
      /* keep the deterministic description */
    }
  }

  // 7. Engine validation + final deterministic safety over everything shown to people.
  const compiled = compileModule(definition, { reservedIds: RESERVED_MODULE_IDS });
  const texts = compiled.ok ? moduleTexts(compiled.definition) : [definition.meta?.displayName ?? '', definition.meta?.description ?? ''];
  const risk = checkSafety([...texts, prompt], [...new Set([...intent.concerns, ...pre.concerns])]);
  risk.level = stricter(risk.level, pre.level);
  const out = { ...base, intent, definition, notes, provider: { id: used.id, modelId: used.modelId, locality: used.capabilities.locality }, attempts, usedFallback, rawOutput: raw.slice(0, 4000), latencyMs: Date.now() - started };
  if (risk.level === 'blocked') {
    return { ...out, status: 'refused', refusal: `This activity isn't safe to turn into a challenge: ${safetyReason(risk)}.`, issues: compiled.issues, risk };
  }
  if (risk.level === 'private_only') notes.push('You can play this with friends privately, but it can’t be shared by link because of a safety concern.');
  return { ...out, status: 'ok', refusal: null, issues: compiled.issues, risk };
}
