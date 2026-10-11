/**
 * Data modules (ADR-023): DSL validation, safety, anti-farming, registry merge + versioning,
 * built-ins expressed in the DSL, and the new reducer facts (counters, confirmations, zone dwell,
 * offline time).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { definitionHash, ModuleDefinition, uuidv7, type ModuleDefinitionInput } from '@trina/contracts';
import {
  BUILTIN_MODULES,
  challengeFromModule,
  compile,
  compileModule,
  compileModuleOrThrow,
  compileOrThrow,
  cricketDefinition,
  defaultRegistry,
  destinationPoint,
  evaluate,
  fold,
  POINTS_PER_MINUTE_BUDGET,
  RESERVED_MODULE_IDS,
} from './index';
import { DEMO_CENTER, SessionBuilder, fakeSha } from './fixtures';

export const kite: ModuleDefinitionInput = {
  schemaVersion: 'module/1.0',
  id: 'u_kite_flying_7f3a',
  version: 1,
  meta: { displayName: 'Kite flying', description: 'Fly kites with friends at an open field.', icon: 'kite', tags: ['social'] },
  movement: 'stationary_play',
  venue: 'open_ground',
  team: { min: 1, max: 20 },
  params: [{ key: 'targetMinutes', kind: 'int', min: 20, max: 180, default: 45, unit: 'minutes' }],
  counters: [
    { id: 'duels_won', label: 'Kite duels won', unit: 'count', verification: 'peer', maxPerMinute: 0.3, maxPerSession: 20 },
    { id: 'tricks', label: 'Tricks', unit: 'count', verification: 'self_report', maxPerMinute: 2, maxPerSession: 50 },
  ],
  taskTypes: [
    { id: 'airborne', displayName: 'Get a kite in the air', completion: 'evidence', evidence: [{ kind: 'photo', count: 1, hint: 'Your kite in the sky' }], weight: 2 },
    { id: 'string_cleanup', displayName: 'Pick up fallen string', completion: 'evidence', evidence: [{ kind: 'photo', count: 1, hint: 'String in a bag' }], weight: 3 },
  ],
  scoring: { counterRules: [{ counter: 'duels_won', weight: 1, capPerSession: 3 }], dwellWeight: 3 },
  difficulty: [{ param: 'targetMinutes', easy: 30, medium: 45, hard: 90 }],
  safety: { checklist: ['sun_protection'], notes: ['no_glass_coated_string', 'stay_off_rooftops', 'away_from_power_lines'] },
  milestones: [
    { id: 'in_the_field', title: 'In the field', window: 'session', measure: { agg: 'sum', fact: 'zone_dwell_s' }, tiers: [{ tier: 'bronze', gte: 1800 }, { tier: 'silver', gte: 2700 }], stat: 'SENSE' },
    { id: 'duelist', title: 'Duelist', window: 'day', measure: { agg: 'sum', fact: 'u_kite_flying_7f3a.duels_won.confirmed' }, tiers: [{ tier: 'unlock', gte: 1 }], stat: 'AGI' },
    { id: 'trickster', title: 'Trickster', window: 'day', measure: { agg: 'sum', fact: 'u_kite_flying_7f3a.tricks' }, tiers: [{ tier: 'unlock', gte: 5 }], stat: 'SENSE' },
  ],
};

const errorsOf = (input: unknown) => {
  const r = compileModule(input, { reservedIds: RESERVED_MODULE_IDS });
  return r.ok ? [] : r.issues.filter((i) => i.severity === 'error').map((i) => `${i.path}: ${i.message}`);
};

describe('compileModule: a valid custom module', () => {
  const r = compileModule(kite, { reservedIds: RESERVED_MODULE_IDS });
  it('compiles into an ordinary engine module with generated facts and levels', () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.module.kind).toBe('presence');
    expect(r.module.plausibility.maxSpeedMps).toBe(3);
    expect(r.module.factLevels).toMatchObject({
      'u_kite_flying_7f3a.duels_won': 'self_report',
      'u_kite_flying_7f3a.duels_won.confirmed': 'peer',
      'u_kite_flying_7f3a.tricks': 'self_report',
      'u_kite_flying_7f3a.airborne.done_count': 'photo',
    });
    expect(r.module.definitionHash).toBe(definitionHash(ModuleDefinition.parse(kite)));
    expect(r.milestones.map((m) => [m.def.id, m.verification])).toEqual([['in_the_field', 'sensor'], ['duelist', 'peer'], ['trickster', 'self_report']]);
    expect(r.risk.level).toBe('note');
  });
  it('scales params by difficulty from the table (no code)', () => {
    if (!r.ok) return;
    expect(r.module.difficulty!({ targetMinutes: 45 }, 'hard')).toEqual({ targetMinutes: 90 });
  });
});

describe('compileModule: refuses unsafe, farmable or impersonating modules', () => {
  it.each<[string, Partial<ModuleDefinitionInput>, RegExp]>([
    ['rooftop wording', { meta: { displayName: 'Rooftop kites', icon: 'kite' } }, /fall risk/],
    ['driving', { meta: { displayName: 'Drive fast club', icon: 'flag' } }, /motor vehicles/],
    ['glass string', { counters: [{ id: 'manja_cuts', label: 'Manja cuts', unit: 'count', verification: 'peer', maxPerMinute: 1, maxPerSession: 5 }] }, /glass-coated/],
    ['offensive label', { taskTypes: [{ id: 'xx', displayName: 'Kill the other team', completion: 'self_report' }] }, /offensive/],
    ['self-reported counter earning points (farmable)', { scoring: { counterRules: [{ counter: 'tricks', weight: 5, capPerSession: 50 }], dwellWeight: 0 } }, /self-reported/],
    ['a daily threshold beyond healthy limits', { milestones: [{ id: 'mm', title: 'Marathon', window: 'day', measure: { agg: 'sum', fact: 'zone_dwell_s' }, tiers: [{ tier: 'unlock', gte: 36000 }], stat: 'VIT' }] }, /healthy/],
    ['a milestone on a forbidden fact', { milestones: [{ id: 'mm', title: 'Escape', window: 'day', measure: { agg: 'sum', fact: 'boundary_exits' }, tiers: [{ tier: 'unlock', gte: 1 }], stat: 'VIT' }] }, /can't use/],
    ['a night-time filter', { milestones: [{ id: 'mm', title: 'Owl', window: 'day', measure: { agg: 'sessions' }, where: { fact: 'start_local_minute', op: '>', value: 1300 }, tiers: [{ tier: 'unlock', gte: 1 }], stat: 'VIT' }] }, /daylight/],
    ['faster than the movement profile', { plausibility: { maxSpeedMps: 11 } }, /Max speed/],
    ['removing required kite safety notes', { safety: { checklist: [], notes: [] } }, /safety notes/],
    ['an official-looking id', { id: 'u_trina_cup_1a2b' }, /reserved/],
    ['a built-in id', { id: 'walking', origin: 'community' }, /u_<name>|reserved/],
  ])('%s', (_name, patch, msg) => {
    const errs = errorsOf({ ...kite, ...patch });
    expect(errs.join(' | ')).toMatch(msg);
  });

  it('property: any random weights/thresholds either compile within bounds or are refused (never crash)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -5, max: 20 }), fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 600 }), (weight, gte, cap) => {
        const def = {
          ...kite,
          scoring: { counterRules: [{ counter: 'duels_won', weight, capPerSession: cap }], dwellWeight: 1 },
          milestones: [{ id: 'mm', title: 'Field time', window: 'day', measure: { agg: 'sum', fact: 'zone_dwell_s' }, tiers: [{ tier: 'unlock', gte }], stat: 'VIT' }],
        };
        const r = compileModule(def);
        if (r.ok) {
          expect(weight).toBeGreaterThanOrEqual(1);
          expect(weight).toBeLessThanOrEqual(5);
          expect(gte).toBeGreaterThanOrEqual(300);
          expect(gte).toBeLessThanOrEqual(7200);
          expect(cap).toBeLessThanOrEqual(20);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('built-in modules expressed in the DSL', () => {
  it.each(BUILTIN_MODULES.map((m) => m.id))('%s has a descriptor that passes the Module DSL schema and matches its tasks', (id) => {
    const m = defaultRegistry.get(id)!;
    expect(ModuleDefinition.safeParse(m.descriptor).success).toBe(true);
    expect(m.descriptor!.origin).toBe('builtin');
    expect(m.descriptor!.taskTypes.map((t) => [t.id, t.completion])).toEqual(m.taskTypes.map((t) => [t.id, t.completion]));
  });
  it('cricket and football are official data modules in the default registry', () => {
    for (const id of ['cricket', 'football']) {
      const m = defaultRegistry.get(id)!;
      expect(m.origin).toBe('official');
      expect(m.counters!.length).toBeGreaterThan(0);
      expect(m.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('registry merge and versioning', () => {
  const custom = compileModuleOrThrow(kite);
  it('adds runtime modules without touching built-ins', () => {
    const r = defaultRegistry.with([custom]);
    expect(r.get('u_kite_flying_7f3a')).toBe(custom);
    expect(r.taskType('u_kite_flying_7f3a.airborne')?.task.completion).toBe('evidence');
    expect(defaultRegistry.get('u_kite_flying_7f3a')).toBeUndefined();
    expect(r.with([custom]).list().length).toBe(r.list().length); // same pinned content twice: idempotent
  });
  it('refuses to shadow a built-in or official module, or a different version of the same id', () => {
    expect(() => defaultRegistry.with([{ ...custom, id: 'walking' }])).toThrow(/already registered/);
    const v2 = compileModuleOrThrow({ ...kite, version: 2, meta: { ...kite.meta, displayName: 'Kite flying II' } });
    expect(() => defaultRegistry.with([custom]).with([v2])).toThrow(/already registered/);
    expect(() => defaultRegistry.with([{ ...custom, origin: 'official' }])).toThrow(/community/);
  });
  it('challenges must pin custom modules by definitionHash, and the hash must match', () => {
    const registry = defaultRegistry.with([custom]);
    const def = challengeFromModule(custom, { start: DEMO_CENTER, durationMin: 60, difficulty: 'medium' });
    expect(compile(def, registry).ok).toBe(true);
    const unpinned = { ...def, modules: def.modules!.map((m) => ({ ...m, definitionHash: undefined })) };
    expect(JSON.stringify(compile(unpinned, registry).issues)).toMatch(/pinned/);
    const wrong = { ...def, modules: def.modules!.map((m) => ({ ...m, definitionHash: 'f'.repeat(64) })) };
    expect(JSON.stringify(compile(wrong, registry).issues)).toMatch(/does not match/);
    expect(compile(def).ok).toBe(false); // unknown module without the runtime registry
  });
});

describe('points budget by level (8 / 12 / 15 per minute)', () => {
  it('property: challengeFromModule always fits the budget for every module, level and duration', () => {
    const mods = [compileModuleOrThrow(kite), defaultRegistry.get('cricket')!, defaultRegistry.get('football')!];
    fc.assert(
      fc.property(fc.constantFrom(...mods), fc.constantFrom('easy' as const, 'medium' as const, 'hard' as const), fc.integer({ min: 5, max: 240 }), (m, difficulty, durationMin) => {
        const registry = m.origin === 'community' ? defaultRegistry.with([m]) : defaultRegistry;
        const r = compile(challengeFromModule(m, { start: DEMO_CENTER, durationMin, difficulty }), registry);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.maxScore).toBeLessThanOrEqual(POINTS_PER_MINUTE_BUDGET[difficulty] * durationMin);
      }),
      { numRuns: 120 },
    );
  });
  it('rejects a hand-written challenge over the budget, and duration rewards with data modules', () => {
    const def = challengeFromModule(defaultRegistry.get('cricket')!, { start: DEMO_CENTER, durationMin: 30, difficulty: 'easy' });
    const greedy = { ...def, scoring: { ...def.scoring, rules: [...def.scoring!.rules!, { id: 'free', kind: 'metric_rate' as const, metric: 'duration_s' as const, pointsPer: 100, per: 1, cap: 5000 }] } };
    const issues = JSON.stringify(compile(greedy).issues);
    expect(issues).toMatch(/budget/);
    expect(issues).toMatch(/plain duration/);
  });
  it('refuses points for self-reported counts even in hand-written challenges', () => {
    const def = challengeFromModule(defaultRegistry.get('cricket')!, { start: DEMO_CENTER, durationMin: 60, difficulty: 'hard' });
    const farm = { ...def, scoring: { ...def.scoring, rules: [{ id: 'farm', kind: 'per_count' as const, fact: 'cricket.balls_faced', pointsPer: 1, per: 1, cap: 10 }] } };
    expect(JSON.stringify(compile(farm).issues)).toMatch(/self-reported/);
  });
});

describe('reducer v2: counters, confirmations, zone dwell, offline time', () => {
  const cricket = defaultRegistry.get('cricket')!;
  const def = challengeFromModule(cricket, { start: DEMO_CENTER, durationMin: 90, difficulty: 'hard' });
  const compiled = compileOrThrow(def);
  const ids = { challengeId: uuidv7(), definitionHash: fakeSha(1), userId: uuidv7(), deviceId: uuidv7(), start: DEMO_CENTER };
  const claim = (ref: string, value: number) => ({ kind: 'counter' as const, ref, value });
  const confirmation = (id: string, claims: ReturnType<typeof claim>[]) => ({
    confirmationId: id, issuerUserId: uuidv7(), issuerDeviceId: uuidv7(), issuerPublicKey: 'a'.repeat(64), role: 'peer' as const, claims, sig: 'b'.repeat(128),
  });

  it('self-reported counts are counted but earn no points; confirmed ones do', () => {
    const cid = uuidv7();
    const b = new SessionBuilder(ids).start().wait(60 * 50, 10);
    for (let i = 0; i < 12; i++) b.emit('CountReported', { counterId: 'cricket.balls_faced', delta: 1 });
    b.emit('CountReported', { counterId: 'cricket.balls_faced', delta: -2 }); // a correction, append-only
    b.emit('CountReported', { counterId: 'cricket.catches', delta: 1 });
    b.emit('ConfirmationReceived', confirmation(cid, [claim('cricket.catches', 1), claim('cricket.overs_bowled', 2)]));
    b.emit('ConfirmationReceived', confirmation(cid, [claim('cricket.catches', 1)])); // replay: ignored
    b.complete();
    const s = fold(compiled, b.build());
    const r = evaluate(compiled, s);
    expect(r.facts['cricket.balls_faced']).toBe(10);
    expect(r.facts['cricket.catches.confirmed']).toBe(1);
    expect(r.facts['cricket.overs_bowled.confirmed']).toBe(2);
    expect(r.breakdown.find((x) => x.ruleId === 'count_catches')!.points).toBeGreaterThan(0);
    expect(r.breakdown.some((x) => x.label.includes('Balls faced'))).toBe(false);
    expect(r.facts.zone_dwell_s).toBeGreaterThanOrEqual(50 * 60 - 20);
  });

  it('server mode counts only matched confirmations, with the server-approved values', () => {
    const matched = uuidv7();
    const forged = uuidv7();
    const events = new SessionBuilder(ids)
      .start()
      .wait(600, 10)
      .emit('ConfirmationReceived', confirmation(matched, [claim('cricket.catches', 3)]))
      .emit('ConfirmationReceived', confirmation(forged, [claim('cricket.overs_bowled', 4)]))
      .complete()
      .build();
    const facts = evaluate(compiled, fold(compiled, events, { confirmations: { mode: 'final', matched: { [matched]: [claim('cricket.catches', 1)] } } })).facts;
    expect(facts['cricket.catches.confirmed']).toBe(1);
    expect(facts['cricket.overs_bowled.confirmed']).toBe(0);
  });

  it('confirmation tasks cannot be self-completed; the legacy OrganizerConfirmation counts only as self-report', () => {
    const scored = 't_scored_match';
    const events = new SessionBuilder(ids).start().wait(900, 10).completeTask(scored).complete().build();
    const s = fold(compiled, events);
    expect(s.tasks[scored]!.status).not.toBe('done');
    expect(s.tasks[scored]!.rejectedCompletions).toBe(1);
    const legacy = new SessionBuilder(ids).start().wait(60, 10).emit('OrganizerConfirmation', { taskId: scored, confirmedBy: uuidv7() }).complete().build();
    expect(fold(compiled, legacy).tasks[scored]!.doneVia).toBe('legacy_organizer');
  });

  it('counts offline time from ConnectivityChanged and removes server-seen online minutes', () => {
    const b = new SessionBuilder(ids).start().emit('ConnectivityChanged', { online: false, transport: 'none' }).wait(1800, 10);
    const onlineAt = b.now;
    b.emit('ConnectivityChanged', { online: true, transport: 'cellular' }).wait(120, 10).emit('ConnectivityChanged', { online: false, transport: 'none' }).wait(600, 10).complete();
    const s = fold(compiled, b.build());
    const f = evaluate(compiled, s).facts;
    expect(f.offline_s).toBeGreaterThanOrEqual(2390);
    expect(f.offline_s).toBeLessThanOrEqual(2410);
    const less = evaluate(compiled, s, { onlineMono: [[onlineAt - 300_000, onlineAt]] }).facts;
    expect(Number(f.offline_s) - Number(less.offline_s)).toBe(300);
  });

  it('zone dwell ignores time outside the play area and long GPS gaps', () => {
    const far = destinationPoint(DEMO_CENTER, 90, 2000);
    const b = new SessionBuilder(ids).start().wait(600, 10).moveTo(far, 1.4, 10).wait(600, 10).complete();
    const f = evaluate(compiled, fold(compiled, b.build())).facts;
    expect(f.zone_dwell_s).toBeGreaterThan(500);
    expect(f.zone_dwell_s).toBeLessThan(1000);
  });

  it('is deterministic (property): same events → same facts', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -3, max: 5 }).filter((d) => d !== 0), { maxLength: 30 }), (deltas) => {
        const b = new SessionBuilder(ids).start().wait(120, 10);
        for (const d of deltas) b.emit('CountReported', { counterId: 'cricket.balls_faced', delta: d });
        const ev = b.complete().build();
        const a = evaluate(compiled, fold(compiled, ev)).facts;
        const c = evaluate(compiled, fold(compiled, [...ev].reverse())).facts;
        expect(a).toEqual(c);
        expect(Number(a['cricket.balls_faced'])).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 50 },
    );
  });
});

export { cricketDefinition };
