import fc from 'fast-check';
import { ChallengeIntent } from '@trina/contracts';
import { compile, defaultRegistry, haversineM } from '@trina/engine';
import { describe, expect, it } from 'vitest';
import { applyIntentPatch, checkIntent, compileIntent, explainRules, layoutCheckpoints, templateIntent, normalizeLocal } from './index';

const START: [number, number] = [88.35, 22.5115];
// The Challenge Agent composes built-in modules only (data modules use challengeFromModule, ADR-028).
const taskTypes = defaultRegistry.list().filter((m) => (m.origin ?? 'builtin') === 'builtin').flatMap((m) => m.taskTypes.map((t) => ({ module: m.id, type: t.id })));

/** Any intent the schema allows must compile into a valid challenge. */
const intentArb = fc.record({
  durationMin: fc.integer({ min: 10, max: 240 }),
  participants: fc.oneof(
    fc.record({ count: fc.integer({ min: 1, max: 50 }), mode: fc.constant('individual' as const) }),
    fc.record({ count: fc.integer({ min: 2, max: 50 }), mode: fc.constant('team' as const), teams: fc.integer({ min: 1, max: 2 }) }),
  ),
  activities: fc.uniqueArray(fc.constantFrom('walking', 'running', 'cycling'), { minLength: 1, maxLength: 2 }).map((a) => a.map((module) => ({ module }))),
  tasks: fc.array(fc.constantFrom(...taskTypes).chain((t) => fc.record({ module: fc.constant(t.module), type: fc.constant(t.type), quantity: fc.integer({ min: 1, max: 5 }) })), { maxLength: 4 }),
  checkpoints: fc.record({ count: fc.integer({ min: 0, max: 8 }), layout: fc.constantFrom('loop' as const, 'out_and_back' as const, 'scatter' as const) }),
  difficulty: fc.constantFrom('easy' as const, 'medium' as const, 'hard' as const),
  mindful: fc.boolean(),
  unresolved: fc.constant([] as never[]),
});

describe('intent compiler (property-based)', () => {
  it('every schema-valid intent compiles to an engine-valid challenge', () => {
    fc.assert(
      fc.property(intentArb, (raw) => {
        const intent = ChallengeIntent.parse(raw);
        const def = compileIntent(intent, { start: START });
        const r = compile(def);
        if (!r.ok) throw new Error(JSON.stringify(r.issues.filter((i) => i.severity === 'error')));
        // Geometry is produced by code and stays near the start.
        for (const cp of def.checkpoints ?? []) expect(haversineM(START, cp.geometry.center)).toBeLessThan(20_000);
        expect(r.maxScore).toBeLessThanOrEqual(10_000);
      }),
      { numRuns: 200 },
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(intentArb, (raw) => {
        const i = ChallengeIntent.parse(raw);
        expect(compileIntent(i, { start: START })).toEqual(compileIntent(i, { start: START }));
      }),
      { numRuns: 50 },
    );
  });

  it('never rewards speed (no duration_s rules, safety flag on)', () => {
    fc.assert(
      fc.property(intentArb, (raw) => {
        const def = compileIntent(ChallengeIntent.parse(raw), { start: START });
        expect(def.safety?.noSpeedRewards).toBe(true);
        expect((def.scoring?.rules ?? []).some((r) => r.kind === 'metric_rate' && r.metric === 'duration_s')).toBe(false);
      }),
      { numRuns: 50 },
    );
  });
});

describe('layouts', () => {
  it.each(['loop', 'out_and_back', 'scatter'] as const)('%s produces the requested number of distinct points', (layout) => {
    const pts = layoutCheckpoints(START, 5, layout, 3000);
    expect(pts).toHaveLength(5);
    expect(new Set(pts.map((p) => p.join(','))).size).toBe(5);
  });
  it('zero checkpoints → no points', () => {
    expect(layoutCheckpoints(START, 0, 'loop', 3000)).toEqual([]);
  });
});

describe('patches', () => {
  const base = ChallengeIntent.parse({ durationMin: 60, participants: { count: 4, mode: 'team' }, activities: [{ module: 'walking' }], tasks: [{ module: 'cleanup', type: 'collect_items', quantity: 10 }], checkpoints: { count: 4 } });
  it('set/add/remove on whitelisted paths', () => {
    const p = applyIntentPatch(base, {
      ops: [
        { op: 'set', path: 'durationMin', value: 45 },
        { op: 'add', path: 'activities', value: { module: 'cycling' } },
        { op: 'remove', path: 'tasks', value: { module: 'cleanup' } },
        { op: 'set', path: 'participants.count', value: 6 },
      ],
    });
    expect(p.durationMin).toBe(45);
    expect(p.activities.map((a) => a.module)).toEqual(['walking', 'cycling']);
    expect(p.tasks).toEqual([]);
    expect(p.participants.count).toBe(6);
  });
  it('rejects patches producing invalid intents or touching forbidden paths', () => {
    expect(() => applyIntentPatch(base, { ops: [{ op: 'set', path: 'durationMin', value: -5 }] })).toThrow();
    expect(() => applyIntentPatch(base, { ops: [{ op: 'set', path: 'meta.title', value: 'x' }] })).toThrow();
    expect(checkIntent(applyIntentPatch(base, { ops: [{ op: 'add', path: 'activities', value: { module: 'flying' } }] })).ok).toBe(false);
  });
});

describe('template builder robustness', () => {
  it('never throws and always yields a schema-valid intent for arbitrary text (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (text) => {
        const r = checkIntent(templateIntent(text));
        expect(r.ok).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
  it('normalizes Bengali/Hindi numerals and units', () => {
    expect(normalizeLocal('১ ঘন্টা')).toContain('1');
    expect(normalizeLocal('६० मिनट')).toMatch(/60\s+minutes/);
  });
  it('explainRules falls back to official text without a model', async () => {
    const { TemplateProvider } = await import('./index');
    const r = await explainRules(new TemplateProvider(), ['Rule A.', 'Rule B.'], 'what?');
    expect(r.text).toBe('Rule A. Rule B.');
  });
});
