import { type ChallengeDefinitionInput, type ChallengeIntent, type CompileIssue, type LngLat, type WellnessDto } from '@trina/contracts';
import { compile, defaultRegistry, type ModuleRegistry } from '@trina/engine';
import { buildIntentJsonSchema, checkIntent, extractJson } from './intent/schema';
import { compileIntent } from './intent/compile-intent';
import { applyIntentPatch } from './intent/patch';
import { explainMessages, intentMessages, patchMessages, PROMPT_VERSIONS, recapMessages, repairMessages } from './prompts';
import type { LLMProvider, Locality } from './provider';
import { TemplateProvider, templateIntent } from './providers/template';

export const MAX_REPAIR_ATTEMPTS = 2;

export type DraftResult = {
  intent: ChallengeIntent;
  definition: ChallengeDefinitionInput | null;
  issues: CompileIssue[];
  notes: string[];
  provider: { id: string; modelId: string; locality: Locality };
  promptVersion: string;
  attempts: number;
  usedFallback: boolean;
  latencyMs: number;
  rawOutput: string;
};

export type AgentOptions = { registry?: ModuleRegistry; signal?: AbortSignal };

/**
 * The Challenge Agent pipeline: constrained generation → validation → repair (≤2) → template fallback
 * → deterministic compiler → engine validation. The LLM never produces coordinates, points or rules.
 */
export async function createDraft(
  provider: LLMProvider,
  prompt: string,
  ctx: { start?: LngLat } & AgentOptions = {},
): Promise<DraftResult> {
  const registry = ctx.registry ?? defaultRegistry;
  const started = Date.now();
  const notes: string[] = [];
  const base = intentMessages(prompt, registry);
  const schema = buildIntentJsonSchema(registry);
  let messages = base;
  let attempts = 0;
  let raw = '';
  let intent: ChallengeIntent | null = null;
  let usedFallback = false;
  let used: LLMProvider = provider;

  if (provider.capabilities.locality !== 'none') {
    while (attempts <= MAX_REPAIR_ATTEMPTS && !intent) {
      attempts++;
      try {
        const out = await provider.generate({ messages, schema, maxTokens: 400, temperature: 0.2, purpose: PROMPT_VERSIONS.intent, signal: ctx.signal });
        raw = out.text;
        let parsed: unknown;
        try {
          parsed = extractJson(raw);
        } catch (e) {
          messages = repairMessages(raw, [(e as Error).message], base);
          continue;
        }
        const check = checkIntent(parsed, registry);
        if (check.ok) intent = check.intent;
        else messages = repairMessages(raw, check.errors, base);
      } catch (e) {
        notes.push(`AI model unavailable (${(e as Error).message}); used the built-in rule-based builder instead.`);
        break;
      }
    }
  }
  if (!intent) {
    usedFallback = true;
    used = new TemplateProvider();
    if (provider.capabilities.locality !== 'none' && !notes.length) notes.push('The AI answer was not usable; used the built-in rule-based builder instead.');
    const check = checkIntent(templateIntent(prompt), registry);
    if (!check.ok) throw new Error(`Template fallback produced an invalid intent: ${check.errors.join(', ')}`);
    intent = check.intent;
  }

  const result = finalizeDraft(intent, ctx.start, registry);
  return {
    ...result,
    notes: [...notes, ...result.notes],
    provider: { id: used.id, modelId: used.modelId, locality: used.capabilities.locality },
    promptVersion: PROMPT_VERSIONS.intent,
    attempts,
    usedFallback,
    latencyMs: Date.now() - started,
    rawOutput: raw.slice(0, 4000),
  };
}

/** Intent → definition → engine compile. Shared by create, patch and difficulty shifts. */
export function finalizeDraft(intent: ChallengeIntent, start: LngLat | undefined, registry: ModuleRegistry = defaultRegistry) {
  const notes: string[] = [];
  if (!start) {
    notes.push('Pick a start point on the map to place checkpoints.');
    return { intent, definition: null, issues: [] as CompileIssue[], notes };
  }
  const definition = compileIntent(intent, { start, registry });
  const r = compile(definition, registry);
  const issues = r.issues;
  for (const i of issues) if (i.severity === 'warning') notes.push(i.message);
  return { intent, definition, issues, notes };
}

export async function patchDraft(provider: LLMProvider, intent: ChallengeIntent, instruction: string, ctx: { start?: LngLat } & AgentOptions = {}) {
  const registry = ctx.registry ?? defaultRegistry;
  const out = await provider.generate({
    messages: patchMessages(instruction, JSON.stringify(intent)),
    maxTokens: 300,
    temperature: 0.1,
    purpose: PROMPT_VERSIONS.patch,
    signal: ctx.signal,
  });
  const next = applyIntentPatch(intent, extractJson(out.text));
  const check = checkIntent(next, registry);
  if (!check.ok) throw new Error(`Patched intent invalid: ${check.errors.join(', ')}`);
  return finalizeDraft(check.intent, ctx.start, registry);
}

/* --------------------------------- Recap --------------------------------- */

export type RecapFacts = { title: string; points: number; distanceKm: number; minutes: number } & Partial<WellnessDto>;

function recapNumbers(f: RecapFacts): Record<string, number | string | null> {
  return {
    challenge: f.title,
    points: f.points,
    distance_km: f.distanceKm,
    minutes: f.minutes,
    steps: f.steps ?? null,
    kcal_estimate: f.kcalEstimate ?? null,
    phone_free_minutes: f.phoneFreeMinutes ?? null,
    mood_before: f.moodBefore ?? null,
    mood_after: f.moodAfter ?? null,
  };
}

/** Deterministic recap used offline / when a model is unavailable / when the model invents numbers. */
export function templateRecap(f: RecapFacts): string {
  const parts = [`You finished ${f.title} with ${f.points} points`];
  if (f.steps) parts.push(`${f.steps.toLocaleString('en-US')} steps`);
  if (f.kcalEstimate) parts.push(`about ${f.kcalEstimate} kcal (estimate)`);
  let s = `${parts.join(', ')}.`;
  if (f.phoneFreeMinutes) s += ` ${f.phoneFreeMinutes} of ${f.minutes} minutes were phone-free.`;
  if (f.moodBefore && f.moodAfter && f.moodAfter > f.moodBefore) s += ' And you felt better afterwards 🌱';
  return s;
}

/** Guard: the model may only use numbers it was given. */
export function recapUsesOnlyGivenNumbers(text: string, f: RecapFacts): boolean {
  const allowed = new Set(
    Object.values(recapNumbers(f))
      .filter((v): v is number => typeof v === 'number')
      .flatMap((n) => [String(n), n.toLocaleString('en-US'), String(Math.round(n))]),
  );
  const found = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return found.every((n) => allowed.has(n) || allowed.has(n.replace(/,/g, '')));
}

export async function recap(provider: LLMProvider, f: RecapFacts, opts: AgentOptions = {}): Promise<{ text: string; provider: string }> {
  if (provider.capabilities.locality === 'none') return { text: templateRecap(f), provider: 'template' };
  try {
    const out = await provider.generate({ messages: recapMessages(recapNumbers(f)), maxTokens: 120, temperature: 0.6, purpose: PROMPT_VERSIONS.recap, signal: opts.signal });
    const text = out.text.trim().replace(/^"|"$/g, '');
    if (text && text.length < 400 && recapUsesOnlyGivenNumbers(text, f)) return { text, provider: provider.id };
  } catch {
    /* fall through to template */
  }
  return { text: templateRecap(f), provider: 'template' };
}

export async function explainRules(provider: LLMProvider, ruleLines: string[], question: string, opts: AgentOptions = {}) {
  if (provider.capabilities.locality === 'none') return { text: ruleLines.join(' '), provider: 'template' };
  try {
    const out = await provider.generate({ messages: explainMessages(ruleLines, question), maxTokens: 200, temperature: 0.3, purpose: PROMPT_VERSIONS.explain, signal: opts.signal });
    if (out.text.trim()) return { text: out.text.trim(), provider: provider.id };
  } catch {
    /* fall through */
  }
  return { text: ruleLines.join(' '), provider: 'template' };
}
