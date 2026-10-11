/**
 * Property-based tests: invariants that must hold for ANY session, not just hand-picked ones.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, computeEventHash, definitionHash, uuidv7, verifyChain, type ActivityEvent, type LngLat } from '@trina/contracts';
import { bearingDeg, compileOrThrow, destinationPoint, evalCondition, evaluate, fold, haversineM, wellness } from './index';
import { SessionBuilder, fakeSha, greenSprintDefinition, greenSprintPoints } from './fixtures';

const def = greenSprintDefinition();
const compiled = compileOrThrow(def);
const ids = { challengeId: uuidv7(), definitionHash: definitionHash(compiled.definition), userId: uuidv7(), deviceId: uuidv7() };
const P = greenSprintPoints();
const targets: LngLat[] = [P.start, P.cp1, P.cp2, P.cp3, P.cp4];

/** A random action script → a sealed event log produced by the real SessionBuilder. */
const action = fc.oneof(
  fc.record({ k: fc.constant('move' as const), to: fc.integer({ min: 0, max: 4 }), speed: fc.double({ min: 0.5, max: 6, noNaN: true }) }),
  fc.record({ k: fc.constant('wait' as const), s: fc.integer({ min: 5, max: 300 }) }),
  fc.record({ k: fc.constant('teleport' as const), bearing: fc.integer({ min: 0, max: 359 }), dist: fc.integer({ min: 0, max: 5000 }), mocked: fc.boolean() }),
  fc.record({ k: fc.constant('evidence' as const), task: fc.constantFrom('litter', 'tree1', 'tree2'), n: fc.integer({ min: 1, max: 9 }) }),
  fc.record({ k: fc.constant('complete' as const), task: fc.constantFrom('litter', 'tree1', 'tree2', 'nope') }),
  fc.record({ k: fc.constant('steps' as const) }),
  fc.record({ k: fc.constant('pause' as const), ms: fc.integer({ min: 1000, max: 600_000 }) }),
  fc.record({ k: fc.constant('background' as const), ms: fc.integer({ min: 1000, max: 600_000 }) }),
);

type Action = typeof action extends fc.Arbitrary<infer A> ? A : never;

function buildSession(script: Action[], end: 'complete' | 'abandon' | 'none'): ActivityEvent[] {
  const b = new SessionBuilder({ ...ids, start: P.start });
  b.start();
  let pos = P.start;
  for (const a of script) {
    if (a.k === 'move') {
      b.moveTo(targets[a.to]!, a.speed, 5);
      pos = targets[a.to]!;
    } else if (a.k === 'wait') b.wait(a.s);
    else if (a.k === 'teleport') {
      pos = destinationPoint(P.start, a.bearing, a.dist);
      b.teleport(pos, { mocked: a.mocked });
    } else if (a.k === 'evidence') b.evidence(a.task, fakeSha(a.n));
    else if (a.k === 'complete') b.completeTask(a.task);
    else if (a.k === 'steps') b.emit('StepsSample', { cumulative: 1000, delta: 100, source: 'simulated' });
    else if (a.k === 'pause') {
      b.emit('SessionPaused', {});
      b.advance(a.ms);
      b.emit('SessionResumed', {});
    } else b.background(a.ms);
  }
  if (end === 'complete') b.complete();
  if (end === 'abandon') b.emit('SessionAbandoned', { reason: 'test' });
  return b.build();
}

const scripts = fc.array(action, { minLength: 0, maxLength: 25 });
const endings = fc.constantFrom('complete' as const, 'abandon' as const, 'none' as const);
const RUNS = { numRuns: 150 };

describe('engine invariants (property-based)', () => {
  it('score is always within [0, maxScore] and integer', () => {
    fc.assert(
      fc.property(scripts, endings, (s, e) => {
        const r = evaluate(compiled, fold(compiled, buildSession(s, e)));
        expect(Number.isInteger(r.total)).toBe(true);
        expect(r.total).toBeGreaterThanOrEqual(0);
        expect(r.total).toBeLessThanOrEqual(compiled.maxScore);
      }),
      RUNS,
    );
  });

  it('is deterministic and independent of delivery order (events are sorted by seq)', () => {
    fc.assert(
      fc.property(scripts, endings, fc.integer(), (s, e, seed) => {
        const events = buildSession(s, e);
        const shuffled = [...events].sort((a, b) => ((a.seq * 7919 + seed) % 97) - ((b.seq * 7919 + seed) % 97));
        const a = evaluate(compiled, fold(compiled, events));
        const b = evaluate(compiled, fold(compiled, shuffled));
        expect(canonicalJson(a)).toBe(canonicalJson(b));
      }),
      RUNS,
    );
  });

  it('abandoned sessions are never "completed" and never earn the completion bonus', () => {
    fc.assert(
      fc.property(scripts, (s) => {
        const r = evaluate(compiled, fold(compiled, buildSession(s, 'abandon')));
        expect(r.completed).toBe(false);
        expect(r.breakdown.find((b) => b.ruleId === 'finish')!.points).toBe(0);
      }),
      RUNS,
    );
  });

  it('mocked GPS can never reach a checkpoint', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 8 }), (cps) => {
        const b = new SessionBuilder({ ...ids, start: P.start });
        b.start();
        for (const i of cps) b.teleport(targets[i]!, { mocked: true }).wait(30, 5, { mocked: true });
        const s = fold(compiled, b.build());
        expect(Object.values(s.checkpoints).every((c) => !c.reached)).toBe(true);
        expect(s.distanceM).toBe(0);
      }),
      RUNS,
    );
  });

  it('tasks never complete without valid evidence (photo tasks)', () => {
    fc.assert(
      fc.property(scripts, (s) => {
        const st = fold(compiled, buildSession(s, 'none'));
        for (const [id, t] of Object.entries(st.tasks)) {
          if (t.status !== 'done') continue;
          const valid = t.evidenceIds.filter((e) => !st.evidence[e]!.invalidReason);
          expect(valid.length, `task ${id}`).toBeGreaterThanOrEqual(1);
        }
      }),
      RUNS,
    );
  });

  it('duration never exceeds the challenge time limit; wellness numbers stay sane', () => {
    fc.assert(
      fc.property(scripts, endings, (s, e) => {
        const st = fold(compiled, buildSession(s, e));
        const r = evaluate(compiled, st);
        expect(r.facts.duration_s as number).toBeLessThanOrEqual(compiled.definition.timing.durationMin * 60);
        const w = wellness(compiled, st);
        expect(w.activeMinutes).toBeGreaterThanOrEqual(0);
        expect(w.phoneFreeMinutes).toBeLessThanOrEqual(compiled.definition.timing.durationMin);
        if (w.kcalEstimate !== null) expect(w.kcalEstimate).toBeLessThan(2000);
      }),
      RUNS,
    );
  });

  it('every builder log has an intact hash chain, and ANY single-field tamper breaks it', () => {
    fc.assert(
      fc.property(scripts, fc.nat(), (s, pick) => {
        const events = buildSession(s, 'complete');
        expect(verifyChain(events[0]!.sessionId, events)).toEqual({ ok: true });
        const i = pick % events.length;
        const tampered = events.map((e, k) => (k === i ? { ...e, monoMs: e.monoMs + 1 } : e));
        expect(verifyChain(events[0]!.sessionId, tampered).ok).toBe(false);
      }),
      { numRuns: 60 },
    );
  });
});

describe('geo invariants', () => {
  const lngLat = fc.tuple(fc.double({ min: -179, max: 179, noNaN: true }), fc.double({ min: -80, max: 80, noNaN: true })) as fc.Arbitrary<LngLat>;
  it('haversine is symmetric and non-negative', () => {
    fc.assert(
      fc.property(lngLat, lngLat, (a, b) => {
        expect(haversineM(a, b)).toBeCloseTo(haversineM(b, a), 6);
        expect(haversineM(a, b)).toBeGreaterThanOrEqual(0);
      }),
    );
  });
  it('destinationPoint travels the requested distance in the requested direction', () => {
    fc.assert(
      fc.property(lngLat, fc.integer({ min: 0, max: 359 }), fc.integer({ min: 10, max: 20_000 }), (o, brg, d) => {
        const p = destinationPoint(o, brg, d);
        expect(Math.abs(haversineM(o, p) - d)).toBeLessThan(1);
        const back = bearingDeg(o, p);
        const diff = Math.min(Math.abs(back - brg), 360 - Math.abs(back - brg));
        expect(diff).toBeLessThan(1);
      }),
    );
  });
});

describe('condition invariants', () => {
  const fact = fc.constantFrom('distance_m', 'completed', 'checkpoints.reached');
  const cond = fc.record({ fact, op: fc.constantFrom('==', '!=', '<', '<=', '>', '>=') as fc.Arbitrary<'=='>, value: fc.oneof(fc.integer({ min: 0, max: 5 }), fc.boolean()) });
  it('not(not(c)) == c and all/any agree on single conditions', () => {
    fc.assert(
      fc.property(cond, fc.integer({ min: 0, max: 5 }), fc.boolean(), (c, n, b) => {
        const facts = { distance_m: n, completed: b, 'checkpoints.reached': n };
        expect(evalCondition({ not: { not: c } }, facts)).toBe(evalCondition(c, facts));
        expect(evalCondition({ all: [c] }, facts)).toBe(evalCondition(c, facts));
        expect(evalCondition({ any: [c] }, facts)).toBe(evalCondition(c, facts));
      }),
    );
  });
  it('unknown facts are never true', () => {
    expect(evalCondition({ fact: 'nope', op: '==', value: 0 }, {})).toBe(false);
    expect(evalCondition({ fact: 'distance_m', op: '==', value: 'ALL' }, { distance_m: 1 })).toBe(false);
  });
});

describe('payload hashing', () => {
  it('computeEventHash is stable for key order', () => {
    const base = { eventId: uuidv7(), sessionId: uuidv7(), seq: 1, type: 'X', schemaVersion: 1, clientTs: '2026-01-01T00:00:00.000Z', monoMs: 0, payload: { b: 1, a: 2 }, prevHash: 'a'.repeat(64) };
    expect(computeEventHash(base)).toBe(computeEventHash({ ...base, payload: { a: 2, b: 1 } }));
  });
});
