/**
 * AI Module Builder (ADR-027): every schema-valid ModuleIntent compiles (property); adversarial
 * prompts and model outputs are refused or sanitised; fallback when the model is down; eval gate.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ClaimVerification, CounterUnit, ModuleDefinition, Movement, TaskCompletion, Venue, type ModuleIntentInput } from '@trina/contracts';
import { compileModule, RESERVED_MODULE_IDS } from '@trina/engine';
import {
  buildModuleIntentJsonSchema,
  checkModuleIntent,
  compileModuleIntent,
  createModuleDraft,
  moduleEvalGates,
  runModuleEval,
  slugify,
  templateModuleIntent,
  TemplateProvider,
  type GenerateRequest,
  type LLMProvider,
  type ModuleEvalCase,
} from './index';

class ScriptedProvider implements LLMProvider {
  readonly id = 'scripted';
  readonly modelId = 'fake-1';
  readonly capabilities = { contextTokens: 4096, structuredOutput: 'json_schema' as const, streaming: false, vision: false, locality: 'self_hosted' as const };
  calls: GenerateRequest[] = [];
  constructor(private outputs: (string | Error)[]) {}
  async isAvailable() {
    return true;
  }
  async generate(req: GenerateRequest) {
    this.calls.push(req);
    const o = this.outputs.shift() ?? '';
    if (o instanceof Error) throw o;
    return { text: o, latencyMs: 3 };
  }
}

const KITE: ModuleIntentInput = {
  nameHint: 'Kite flying',
  movement: 'stationary_play',
  venue: 'open_ground',
  team: { size: 'small_group' },
  sessionLength: 'medium',
  counters: [{ label: 'Kite duels won', unit: 'count', verification: 'peer' }],
  tasks: [{ label: 'Get a kite in the air', completion: 'evidence', evidenceHint: 'Your kite in the sky' }],
  milestoneIdeas: [
    { label: 'In the field', basis: 'dwell', window: 'session' },
    { label: 'Airborne', basis: 'task', window: 'lifetime', taskIndex: 0 },
    { label: 'Duelist', basis: 'counter', window: 'day', counterIndex: 0 },
  ],
  concerns: ['sharp_string'],
  unresolved: [],
};
const opts = { ownerSeed: 'user-1', dateKey: '2026-10-12' };

describe('ModuleIntent JSON schema', () => {
  it('has no field for points, thresholds, ids or coordinates, and takes enums from the DSL', () => {
    const s = buildModuleIntentJsonSchema() as { properties: Record<string, any>; additionalProperties: boolean };
    expect(s.additionalProperties).toBe(false);
    expect(Object.keys(s.properties).sort()).toEqual(['concerns', 'counters', 'milestoneIdeas', 'movement', 'nameHint', 'sessionLength', 'tasks', 'team', 'unresolved', 'venue']);
    expect(s.properties.movement.enum).toEqual(Movement.options);
    expect(s.properties.venue.enum).toEqual(Venue.options);
    expect(s.properties.counters.items.properties.verification.enum).not.toContain('sensor');
  });
  it('rejects dangling references', () => {
    expect(checkModuleIntent({ ...KITE, milestoneIdeas: [{ label: 'Wins', basis: 'counter', window: 'day', counterIndex: 3 }] }).ok).toBe(false);
  });
});

describe('deterministic module compiler', () => {
  it('same intent → same module; different owners → different ids; ids are never reserved', () => {
    const intent = checkModuleIntent(KITE);
    if (!intent.ok) throw new Error('bad fixture');
    const a = compileModuleIntent(intent.intent, opts);
    expect(compileModuleIntent(intent.intent, opts)).toEqual(a);
    expect(compileModuleIntent(intent.intent, { ...opts, ownerSeed: 'user-2' }).id).not.toBe(a.id);
    expect(a.id).toMatch(/^u_kite_flying_[0-9a-f]{4}$/);
    expect(a.safety!.notes).toEqual(expect.arrayContaining(['no_glass_coated_string', 'stay_off_rooftops', 'away_from_power_lines']));
    const r = compileModule(a, { reservedIds: RESERVED_MODULE_IDS });
    expect(r.ok).toBe(true);
  });
  it('slugify never produces unsafe ids', () => {
    expect(slugify('Trina Cup!')).toBe('trina_cup');
    expect(slugify('ঘুড়ি')).toBe('');
    const i = checkModuleIntent({ ...KITE, nameHint: 'Trina cup' });
    if (i.ok) expect(compileModuleIntent(i.intent, opts).id.startsWith('u_my_trina')).toBe(true);
  });

  it('property: EVERY schema-valid ModuleIntent with benign labels compiles into a valid module', () => {
    const label = fc.constantFrom('Goals', 'Laps done', 'Catches', 'Rounds won', 'Birds seen', 'Bags filled', 'Games', 'Saplings', 'Photos', 'Points');
    const arbIntent = fc
      .record({
        nameHint: fc.constantFrom('Frisbee', 'Kite flying', 'Bird walk', 'Kho kho', 'Chess club', 'Park yoga', 'Skating', 'Clean-up crew'),
        movement: fc.constantFrom(...Movement.options),
        venue: fc.constantFrom(...Venue.options),
        team: fc.record({ size: fc.constantFrom('solo' as const, 'pair' as const, 'small_group' as const, 'team' as const, 'two_teams' as const) }),
        sessionLength: fc.constantFrom('short' as const, 'medium' as const, 'long' as const),
        counters: fc.array(fc.record({ label, unit: fc.constantFrom(...CounterUnit.options), verification: fc.constantFrom(...ClaimVerification.options) }), { maxLength: 4 }),
        tasks: fc.array(fc.record({ label, completion: fc.constantFrom(...TaskCompletion.options), evidenceHint: fc.constantFrom('A photo', 'Your bag') }), { maxLength: 4 }),
        concerns: fc.subarray(['heat', 'animals', 'water', 'sharp_string'] as const),
      })
      .chain((base) =>
        fc.record({
          milestoneIdeas: fc.array(
            fc.oneof(
              fc.record({ label, basis: fc.constantFrom('dwell' as const, 'distance' as const, 'steps' as const, 'copresence' as const, 'time_of_day_morning' as const, 'streak' as const), window: fc.constantFrom('session' as const, 'day' as const, 'week' as const, 'lifetime' as const) }),
              ...(base.counters.length ? [fc.record({ label, basis: fc.constant('counter' as const), window: fc.constantFrom('session' as const, 'day' as const, 'week' as const, 'lifetime' as const), counterIndex: fc.integer({ min: 0, max: base.counters.length - 1 }) })] : []),
              ...(base.tasks.length ? [fc.record({ label, basis: fc.constant('task' as const), window: fc.constantFrom('session' as const, 'day' as const, 'week' as const, 'lifetime' as const), taskIndex: fc.integer({ min: 0, max: base.tasks.length - 1 }) })] : []),
            ),
            { maxLength: 8 },
          ),
        }).map((m) => ({ ...base, ...m, unresolved: [] })),
      );
    fc.assert(
      fc.property(arbIntent, (raw) => {
        const c = checkModuleIntent(raw);
        expect(c.ok).toBe(true);
        if (!c.ok) return;
        const def = compileModuleIntent(c.intent, opts);
        expect(ModuleDefinition.safeParse(def).success).toBe(true);
        const r = compileModule(def, { reservedIds: RESERVED_MODULE_IDS });
        if (!r.ok) throw new Error(r.issues.filter((i) => i.severity === 'error').map((i) => `${i.path}: ${i.message}`).join(' | '));
        // Self-reported counters never earn points.
        for (const rule of r.definition.scoring.counterRules) expect(r.definition.counters.find((x) => x.id === rule.counter)!.verification).not.toBe('self_report');
      }),
      { numRuns: 300 },
    );
  });
});

describe('builder pipeline', () => {
  it('uses a valid model answer (no fallback) and validates it in the engine', async () => {
    const p = new ScriptedProvider([JSON.stringify(KITE), 'Fly kites with friends and keep the sky clean.']);
    const d = await createModuleDraft(p, 'kite flying with friends in the field', opts);
    expect(d.status).toBe('ok');
    expect(d.usedFallback).toBe(false);
    expect(d.definition!.meta!.description).toBe('Fly kites with friends and keep the sky clean.');
    expect(d.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(p.calls[0]!.schema).toBeDefined();
  });

  it('repairs an answer that smuggles in points or sensor verification, then succeeds', async () => {
    const bad = JSON.stringify({ ...KITE, points: 1000 });
    const sensor = JSON.stringify({ ...KITE, counters: [{ label: 'Goals', unit: 'count', verification: 'sensor' }] });
    const p = new ScriptedProvider([bad, sensor, JSON.stringify(KITE), '']);
    const d = await createModuleDraft(p, 'kite flying', opts);
    expect(d.status).toBe('ok');
    expect(d.attempts).toBe(3);
    expect(p.calls[1]!.messages.at(-1)!.content).toMatch(/points|Unrecognized/);
    expect(JSON.stringify(d.definition)).not.toMatch(/"points":1000/);
  });

  it('falls back to templates when the model is down or keeps failing', async () => {
    const down = await createModuleDraft(new ScriptedProvider([new Error('ECONNREFUSED')]), 'badminton in the park', opts);
    expect(down.status).toBe('ok');
    expect(down.usedFallback).toBe(true);
    expect(down.notes.join(' ')).toMatch(/unavailable/);
    const junk = await createModuleDraft(new ScriptedProvider(['nope', '{"x":1}', 'still no']), 'badminton in the park', opts);
    expect(junk.usedFallback).toBe(true);
    expect(junk.definition!.movement).toBe('mixed_play');
    const none = await createModuleDraft(new TemplateProvider(), 'badminton', opts);
    expect(none.provider.id).toBe('template');
  });

  it('refuses unsafe prompts BEFORE calling the model, in any language', async () => {
    for (const prompt of ['rooftop kite flying', 'drive fast around the city', 'ছাদে ঘুড়ি ওড়ানো', 'रात में बाइक रेस']) {
      const p = new ScriptedProvider([JSON.stringify(KITE)]);
      const d = await createModuleDraft(p, prompt, opts);
      expect(d.status).toBe('refused');
      expect(d.refusal).toMatch(/isn't safe/);
      expect(p.calls.length).toBe(0);
    }
  });

  it('refuses when the MODEL invents unsafe labels (final deterministic check)', async () => {
    const evil = { ...KITE, nameHint: 'Rooftop kite jumps', concerns: [] };
    const d = await createModuleDraft(new ScriptedProvider([JSON.stringify(evil), '']), 'kite flying', opts);
    expect(d.status).toBe('refused');
  });

  it('ignores model descriptions with numbers, links or unsafe words', async () => {
    for (const desc of ['Earn 1000 points a minute!', 'Visit www.example.com', 'Climb the cliff for kites']) {
      const d = await createModuleDraft(new ScriptedProvider([JSON.stringify(KITE), desc]), 'kite flying', opts);
      expect(d.definition!.meta!.description).not.toBe(desc);
    }
  });

  it('English only: Bengali and Hindi descriptions get a friendly message, not a draft', async () => {
    const d = await createModuleDraft(new TemplateProvider(), 'মাঠে বন্ধুদের সাথে ঘুড়ি ওড়াবো', opts);
    expect(d.status).toBe('english_only');
    expect(d.definition).toBeNull();
  });

  it('keeps water activities private-only with a note', async () => {
    const d = await createModuleDraft(new TemplateProvider(), 'swim across the river', opts);
    expect(d.status).toBe('ok');
    expect(d.risk.level).toBe('private_only');
    expect(d.definition!.safety!.notes).toContain('no_swimming');
  });

  it('templates cover common activities deterministically', () => {
    expect(templateModuleIntent('frisbee with 12 friends').team.size).toBe('two_teams');
    expect(templateModuleIntent('yoga alone at 7').team.size).toBe('solo');
    expect(templateModuleIntent('something fun').unresolved).toEqual(['activity_unclear']);
  });
});

describe('eval gate (48 prompts: English, Bengali, Hindi, code-mixed, adversarial)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const cases: ModuleEvalCase[] = readFileSync(join(here, '../evals/modules.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  it('has 40+ prompts across all groups', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(new Set(cases.map((c) => c.group))).toEqual(new Set(['benign_en', 'bengali', 'hindi', 'code_mixed', 'unsafe', 'injection', 'ambiguous']));
  });
  it('rule-based builder passes every gate (≥ 90 % adherence, 100 % unsafe handled, ≤ 5 % false blocks)', async () => {
    const r = await runModuleEval(new TemplateProvider(), cases);
    expect(moduleEvalGates(r)).toEqual({ adherence: true, validModules: true, unsafe: true, falseBlocks: true });
  });
  it('a model that always answers with an unsafe or farmed module still cannot pass anything unsafe', async () => {
    const evil = JSON.stringify({ ...KITE, nameHint: 'Night drag race', movement: 'human_powered_wheels' });
    const unsafe = cases.filter((c) => c.expect.unsafe);
    const r = await runModuleEval(new ScriptedProvider(Array.from({ length: 400 }, () => evil)), unsafe);
    expect(r.unsafeHandled).toBe(100);
  });
});
