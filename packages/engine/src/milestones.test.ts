/**
 * Milestone evaluator (ADR-024/025), progression and Daily Quests: invariants and examples.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { definitionHash, uuidv7 } from '@trina/contracts';
import {
  addDays,
  buildMilestoneCatalog,
  buildQuestDefinition,
  challengeFromModule,
  coPresence,
  compile,
  compileOrThrow,
  dayKeyOf,
  defaultRegistry,
  evaluateMilestones,
  fold,
  longestStreak,
  pickDailyQuests,
  progression,
  RANK_THRESHOLDS,
  summarizeSession,
  unlockId,
  unlocksOf,
  weekKeyOf,
  type MilestoneUnlock,
  type SessionSummary,
} from './index';
import { DEMO_CENTER, SessionBuilder, fakeSha } from './fixtures';

const catalog = buildMilestoneCatalog(defaultRegistry);
const USER = uuidv7();

/** A synthetic summary (evaluator input) for property tests. */
function summary(p: Partial<SessionSummary> & { dayKey: string; facts?: Record<string, number | boolean> }): SessionSummary {
  return {
    sessionId: p.sessionId ?? uuidv7(),
    userId: p.userId ?? USER,
    challengeId: p.challengeId ?? 'c1',
    moduleIds: p.moduleIds ?? ['walking'],
    moduleVersions: {},
    startMs: p.startMs ?? Date.parse(`${p.dayKey}T08:00:00Z`),
    tzOffsetMin: 0,
    dayKey: p.dayKey,
    weekKey: weekKeyOf(p.dayKey),
    monthKey: p.dayKey.slice(0, 7),
    dayKeyApprox: false,
    facts: { zone_dwell_s: 0, steps: 0, distance_m: 0, offline_s: 0, photo_proofs: 0, duration_s: 0, moving_time_s: 0, active_minutes: 0, phone_free_minutes: 0, start_local_minute: 600, 'checkpoints.reached': 0, completed: true, ...(p.facts ?? {}) },
    factLevels: {},
    placeKeys: p.placeKeys ?? [],
    zoneIntervalsMs: p.zoneIntervalsMs ?? [],
    status: p.status ?? 'completed',
    questStop: p.questStop ?? null,
    isQuest: p.isQuest ?? false,
    verified: p.verified ?? true,
  };
}

describe('catalogue', () => {
  it('compiles the generic quests and every module milestone (built-in + official data modules)', () => {
    const keys = catalog.map((m) => m.key);
    expect(keys).toEqual(expect.arrayContaining(['*@1:q_offline_30', 'walking@1:steps_outside', 'tree_care@1:same_tree', 'cricket@1:took_catch', 'football@1:scored']));
    expect(new Set(keys).size).toBe(keys.length);
    expect(catalog.find((m) => m.key === 'cricket@1:took_catch')!.verification).toBe('peer');
    expect(catalog.find((m) => m.key === 'cricket@1:full_side')!.serverOnly).toBe(true);
  });
});

describe('day keys: 04:00 local boundary and time zones (ADR-025)', () => {
  const IST = 330;
  it.each([
    ['2026-10-12T22:29:00Z', IST, '2026-10-12'], // 03:59 IST on the 13th → still the 12th
    ['2026-10-12T22:31:00Z', IST, '2026-10-13'], // 04:01 IST → the 13th
    ['2026-10-12T18:00:00Z', IST, '2026-10-12'], // 23:30 IST
    ['2026-10-13T03:30:00Z', 0, '2026-10-12'], // 03:30 UTC
    ['2026-10-13T04:30:00Z', 0, '2026-10-13'],
    ['2026-10-13T10:00:00Z', -300, '2026-10-13'], // New York morning
  ])('%s at %i min → %s', (ts, tz, day) => {
    expect(dayKeyOf(Date.parse(ts), tz)).toBe(day);
  });
  it('ISO weeks (Monday start, Thursday rule)', () => {
    expect(weekKeyOf('2026-01-01')).toBe('2026-W01');
    expect(weekKeyOf('2026-10-12')).toBe('2026-W42');
    expect(weekKeyOf('2027-01-01')).toBe('2026-W53');
    expect(weekKeyOf('2026-12-28')).toBe('2026-W53');
  });
  it('a session crossing midnight belongs entirely to its start day', () => {
    const def = buildQuestDefinition({ templateId: 'outside_v1', targetMinutes: 90, levelTier: 'hard' }, DEMO_CENTER);
    const compiled = compileOrThrow(def);
    const b = new SessionBuilder({ challengeId: uuidv7(), definitionHash: definitionHash(compiled.definition), userId: USER, deviceId: uuidv7(), start: DEMO_CENTER, startTs: '2026-10-12T17:45:00Z' });
    b.emit('SessionStarted', {
      challengeId: uuidv7(), challengeVersion: 1, definitionHash: fakeSha(1), deviceId: uuidv7(), userId: USER, teamId: null, bootId: 'b', clockOffsetMsAtDownload: 0,
      startFix: { lat: DEMO_CENTER[1], lng: DEMO_CENTER[0], acc: 5, ts: '2026-10-12T17:45:00Z' }, tzOffsetMin: 330, quest: { templateId: 'outside_v1', targetMinutes: 90, levelTier: 'hard' },
    });
    b.wait(90 * 60, 30).complete(); // 23:15 → 00:45 IST
    const s = summarizeSession(compiled, fold(compiled, b.build()), { userId: USER, challengeId: 'q', verified: true });
    expect(s.dayKey).toBe('2026-10-12');
    expect(s.isQuest).toBe(true);
  });
  it('old apps without a recorded offset fall back and are marked approximate', () => {
    const compiled = compileOrThrow(buildQuestDefinition({ templateId: 'outside_v1', targetMinutes: 30, levelTier: 'easy' }, DEMO_CENTER));
    const ev = new SessionBuilder({ challengeId: uuidv7(), definitionHash: fakeSha(2), userId: USER, deviceId: uuidv7(), start: DEMO_CENTER }).start().wait(60).complete().build();
    const s = summarizeSession(compiled, fold(compiled, ev), { userId: USER, challengeId: 'q', verified: false, fallbackTzOffsetMin: 330 });
    expect(s.dayKeyApprox).toBe(true);
  });
});

describe('evaluateMilestones invariants (property)', () => {
  const day = fc.integer({ min: 0, max: 40 }).map((n) => addDays('2026-10-01', n));
  const arbSummary = fc.record({
    day,
    steps: fc.integer({ min: 0, max: 12_000 }),
    dwell: fc.integer({ min: 0, max: 7200 }),
    offline: fc.integer({ min: 0, max: 7200 }),
    photos: fc.integer({ min: 0, max: 3 }),
    start: fc.integer({ min: 300, max: 1100 }),
    verified: fc.boolean(),
    module: fc.constantFrom('walking', 'cricket', 'tree_care'),
    trees: fc.integer({ min: 0, max: 3 }),
    place: fc.constantFrom('c1:cp1', 'c1:cp2', 'c2:cp1'),
  });
  const toSummaries = (xs: fc.Arbitrary<Array<fc.Arbitrary<unknown> extends never ? never : any>>) => xs;
  const build = (raw: Array<{ day: string; steps: number; dwell: number; offline: number; photos: number; start: number; verified: boolean; module: string; trees: number; place: string }>) =>
    raw.map((r, i) =>
      summary({
        sessionId: `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`,
        dayKey: r.day,
        moduleIds: [r.module],
        verified: r.verified,
        placeKeys: [r.place],
        facts: { steps: r.steps, zone_dwell_s: r.dwell, offline_s: r.offline, photo_proofs: r.photos, start_local_minute: r.start, duration_s: r.dwell, 'tree_care.water_tree.done_count': r.trees, distance_m: r.steps },
      }),
    );
  void toSummaries;

  it('is deterministic and order-independent', () => {
    fc.assert(
      fc.property(fc.array(arbSummary, { maxLength: 25 }), fc.integer(), (raw, seed) => {
        const xs = build(raw);
        const shuffled = [...xs].sort((a, b) => ((a.sessionId.charCodeAt(30) * seed) % 7) - ((b.sessionId.charCodeAt(30) * seed) % 7));
        expect(evaluateMilestones(catalog, shuffled, { mode: 'provisional' })).toEqual(evaluateMilestones(catalog, xs, { mode: 'provisional' }));
      }),
      { numRuns: 60 },
    );
  });

  it('never unlocks without the facts (all-zero sessions unlock nothing measured)', () => {
    fc.assert(
      fc.property(fc.array(day, { maxLength: 10 }), (days) => {
        const xs = days.map((d) => summary({ dayKey: d, facts: { start_local_minute: 1000, duration_s: 0 } }));
        const unlocked = unlocksOf(evaluateMilestones(catalog, xs, { mode: 'provisional' }));
        // Only "sessions" counts with no filter could unlock on zero facts; the catalogue has none.
        expect(unlocked).toEqual([]);
      }),
      { numRuns: 40 },
    );
  });

  it('no double unlock: unlock ids are unique, and adding a session never removes an unlock', () => {
    fc.assert(
      fc.property(fc.array(arbSummary, { minLength: 1, maxLength: 20 }), arbSummary, (raw, extra) => {
        const xs = build(raw);
        const before = unlocksOf(evaluateMilestones(catalog, xs, { mode: 'provisional' })).map(unlockId);
        expect(new Set(before).size).toBe(before.length);
        const after = new Set(unlocksOf(evaluateMilestones(catalog, [...xs, ...build([extra]).map((s) => ({ ...s, sessionId: uuidv7() }))], { mode: 'provisional' })).map(unlockId));
        for (const id of before) expect(after.has(id)).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it('final mode only counts verified sessions; provisional counts everything', () => {
    fc.assert(
      fc.property(fc.array(arbSummary, { maxLength: 20 }), (raw) => {
        const xs = build(raw);
        const final = evaluateMilestones(catalog, xs, { mode: 'final' });
        const onlyVerified = evaluateMilestones(catalog, xs.filter((s) => s.verified), { mode: 'provisional' });
        expect(final).toEqual(onlyVerified);
      }),
      { numRuns: 40 },
    );
  });

  it('daily windows reset at the day boundary', () => {
    const a = summary({ dayKey: '2026-10-12', facts: { steps: 1500 } });
    const b = summary({ dayKey: '2026-10-13', facts: { steps: 1500 } });
    const c = summary({ dayKey: '2026-10-12', facts: { steps: 600 } });
    const steps = (xs: SessionSummary[]) => evaluateMilestones(catalog, xs, { mode: 'provisional' }).filter((p) => p.key === '*@1:q_steps_2000');
    expect(steps([a, b]).every((p) => p.tier === null)).toBe(true);
    expect(steps([a, b, c]).find((p) => p.windowKey === '2026-10-12')!.tier).toBe('unlock');
  });
});

describe('streaks, places and examples', () => {
  it('longestStreak: rest days per ISO week keep a streak alive (without counting)', () => {
    expect(longestStreak(['2026-10-12', '2026-10-13', '2026-10-14'], 0)).toBe(3);
    expect(longestStreak(['2026-10-12', '2026-10-14', '2026-10-15'], 1)).toBe(3);
    expect(longestStreak(['2026-10-12', '2026-10-14', '2026-10-15'], 0)).toBe(2);
    expect(longestStreak(['2026-10-12', '2026-10-15'], 1)).toBe(1);
    expect(longestStreak([], 1)).toBe(0);
  });

  it('"same tree, every day" needs the SAME place each day', () => {
    const days = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];
    const same = days.map((d) => summary({ dayKey: d, moduleIds: ['tree_care'], placeKeys: ['c1:tree1'], facts: { 'tree_care.water_tree.done_count': 1 } }));
    const mixed = days.map((d, i) => summary({ dayKey: d, moduleIds: ['tree_care'], placeKeys: [`c1:tree${i % 2}`], facts: { 'tree_care.water_tree.done_count': 1 } }));
    const get = (xs: SessionSummary[]) => evaluateMilestones(catalog, xs, { mode: 'final' }).find((p) => p.key === 'tree_care@1:same_tree');
    expect(get(same)!.tier).toBe('silver');
    expect(get(mixed)?.tier ?? null).toBeNull();
  });

  it('self-reported milestones are labelled as such; co-presence waits for the server', () => {
    const s = summary({ dayKey: '2026-10-12', moduleIds: ['cricket'], facts: { 'cricket.catches.confirmed': 1, zone_dwell_s: 2000 } });
    const p = evaluateMilestones(catalog, [s], { mode: 'provisional' });
    expect(p.find((x) => x.key === 'cricket@1:took_catch')!.verification).toBe('peer');
    const withServer = evaluateMilestones(catalog, [s], { mode: 'final', serverFacts: { [s.sessionId]: { 'copresence.max_players': 7 } } });
    expect(withServer.find((x) => x.key === 'cricket@1:full_side')!.tier).toBe('unlock');
    expect(evaluateMilestones(catalog, [s], { mode: 'final' }).find((x) => x.key === 'cricket@1:full_side')).toBeUndefined();
  });

  it('co-presence only counts other players of the SAME challenge with ≥ 10 min overlap', () => {
    const t = Date.parse('2026-10-12T08:00:00Z');
    const iv = (a: number, b: number): Array<[number, number]> => [[t + a * 60_000, t + b * 60_000]];
    const xs = [
      summary({ sessionId: 's1', userId: 'u1', challengeId: 'c1', dayKey: '2026-10-12', zoneIntervalsMs: iv(0, 60) }),
      summary({ sessionId: 's2', userId: 'u2', challengeId: 'c1', dayKey: '2026-10-12', zoneIntervalsMs: iv(30, 90) }),
      summary({ sessionId: 's3', userId: 'u3', challengeId: 'c1', dayKey: '2026-10-12', zoneIntervalsMs: iv(55, 70) }), // 5 min with s1
      summary({ sessionId: 's4', userId: 'u4', challengeId: 'c2', dayKey: '2026-10-12', zoneIntervalsMs: iv(0, 60) }), // other challenge
    ];
    expect(coPresence(xs)).toEqual({ s1: 2, s2: 3, s3: 2, s4: 1 });
  });
});

describe('progression', () => {
  const u = (p: Partial<MilestoneUnlock>): MilestoneUnlock => ({ key: 'k', windowKey: 'w', tier: 'unlock', verification: 'sensor', stat: 'VIT', dayKey: '2026-10-12', title: 't', ...p });
  const quest = (dayKey: string, offlineMin: number, extra: Partial<SessionSummary> = {}) => summary({ dayKey, isQuest: true, facts: { offline_s: offlineMin * 60, zone_dwell_s: offlineMin * 60 }, ...extra });

  it('tier XP, self-reports earn nothing, daily cap 300', () => {
    expect(progression({ unlocks: [u({ tier: 'gold' })], summaries: [], todayKey: '2026-10-12' }).xp).toBe(50);
    expect(progression({ unlocks: [u({ verification: 'self_report' })], summaries: [], todayKey: '2026-10-12' }).xp).toBe(0);
    const many = Array.from({ length: 40 }, (_, i) => u({ key: `k${i}`, tier: 'gold' }));
    const p = progression({ unlocks: many, summaries: [], todayKey: '2026-10-12' });
    expect(p.todayXp).toBe(300);
    expect(Object.values(p.xpByStat).reduce((a, b) => a + b, 0)).toBe(p.xp);
  });

  it('offline quest minutes earn XP only from 30 to 90 per day', () => {
    const xp = (min: number) => progression({ unlocks: [], summaries: [quest('2026-10-12', min)], todayKey: '2026-10-12' }).xp;
    expect(xp(25)).toBe(0);
    expect(xp(30)).toBe(30);
    expect(xp(60)).toBe(60);
    expect(xp(150)).toBe(90);
  });

  it('+15 for 3 days of 90 offline minutes in a week; −10 once for force stops on 3+ days; safety stops never count', () => {
    const wk = ['2026-10-12', '2026-10-13', '2026-10-14'];
    const bonus = progression({ unlocks: [], summaries: wk.map((d) => quest(d, 90)), todayKey: '2026-10-14' });
    expect(bonus.weeks['2026-W42']!.bonus).toBe(15);
    expect(bonus.xp).toBe(3 * 90 + 15);
    const stops = wk.map((d) => quest(d, 0, { questStop: 'force', status: 'abandoned', verified: false }));
    const pen = progression({ unlocks: [u({ tier: 'gold' })], summaries: [...stops, quest('2026-10-15', 40)], todayKey: '2026-10-15' });
    expect(pen.weeks['2026-W42']!.penalty).toBe(10);
    expect(pen.xp).toBe(50 + 40 - 10);
    const safety = wk.map((d) => quest(d, 0, { questStop: 'safety', status: 'abandoned' }));
    expect(progression({ unlocks: [], summaries: safety, todayKey: '2026-10-14' }).weeks['2026-W42']?.penalty ?? 0).toBe(0);
    const onlyTwo = stops.slice(0, 2);
    expect(progression({ unlocks: [], summaries: onlyTwo, todayKey: '2026-10-14' }).weeks['2026-W42']!.penalty).toBe(0);
    // Weekly XP never goes below zero.
    expect(progression({ unlocks: [], summaries: stops, todayKey: '2026-10-14' }).xp).toBe(0);
  });

  it('rank comes only from activity, offline time and photos; B needs Evidenced AURA; never goes down', () => {
    const big = Array.from({ length: 40 }, (_, i) => quest(addDays('2026-01-01', i), 100, { facts: { offline_s: 100 * 60, zone_dwell_s: 100 * 60, photo_proofs: 2 } }));
    const p = progression({ unlocks: [], summaries: big, todayKey: '2026-03-01' });
    expect(p.rankPoints).toBe(40 * (100 + 100) + 40 * 2 * 5);
    expect(p.rankPoints).toBeLessThan(RANK_THRESHOLDS.A);
    expect(p.rankPoints).toBeGreaterThan(RANK_THRESHOLDS.B);
    expect(p.rank).toBe('C'); // capped: no Evidenced AURA milestones yet
    const aura = [1, 2, 3].map((i) => u({ key: `a${i}`, stat: 'AURA', verification: 'photo' }));
    expect(progression({ unlocks: aura, summaries: big, todayKey: '2026-03-01' }).rank).toBe('B');
    expect(progression({ unlocks: [], summaries: [], todayKey: '2026-03-01', previousRank: 'B' }).rank).toBe('B');
    const confirmedOnly = progression({ unlocks: [u({ verification: 'peer', tier: 'gold' })], summaries: [], todayKey: '2026-03-01' });
    expect(confirmedOnly.rankPoints).toBe(0);
    expect(confirmedOnly.xp).toBe(50);
  });
});

describe('Daily Quests', () => {
  it('the quest definition is deterministic, compiles, and hashes the same on phone and server', () => {
    fc.assert(
      fc.property(fc.double({ min: -179, max: 179, noNaN: true }), fc.double({ min: -60, max: 60, noNaN: true }), fc.constantFrom(30 as const, 45 as const, 60 as const, 90 as const), (lng, lat, target) => {
        const spec = { templateId: 'outside_v1', targetMinutes: target, levelTier: 'easy' as const };
        const a = compile(buildQuestDefinition(spec, [lng, lat]));
        const b = compile(buildQuestDefinition(spec, [lng, lat]));
        expect(a.ok).toBe(true);
        if (a.ok && b.ok) expect(definitionHash(a.compiled.definition)).toBe(definitionHash(b.compiled.definition));
      }),
      { numRuns: 40 },
    );
    expect(() => buildQuestDefinition({ templateId: 'nope', targetMinutes: 30, levelTier: 'easy' }, DEMO_CENTER)).toThrow();
  });

  it('picks 3 distinct quests per day, deterministically, avoiding yesterday where possible', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.integer({ min: 0, max: 400 }), (user, n) => {
        const day = addDays('2026-01-01', n);
        const today = pickDailyQuests(user, day);
        expect(today).toEqual(pickDailyQuests(user, day));
        expect(new Set(today).size).toBe(3);
        const yesterday = new Set(pickDailyQuests(user, addDays(day, -1)));
        expect(today.filter((q) => yesterday.has(q)).length).toBe(0);
      }),
      { numRuns: 60 },
    );
  });

  it('end to end: a 30-min offline quest unlocks the offline quest milestone and earns quest XP', () => {
    const spec = { templateId: 'outside_v1', targetMinutes: 30 as const, levelTier: 'easy' as const };
    const compiled = compileOrThrow(buildQuestDefinition(spec, DEMO_CENTER));
    const b = new SessionBuilder({ challengeId: uuidv7(), definitionHash: definitionHash(compiled.definition), userId: USER, deviceId: uuidv7(), start: DEMO_CENTER, startTs: '2026-10-12T02:00:00Z' });
    b.emit('SessionStarted', {
      challengeId: uuidv7(), challengeVersion: 1, definitionHash: definitionHash(compiled.definition), deviceId: uuidv7(), userId: USER, teamId: null, bootId: 'b', clockOffsetMsAtDownload: 0,
      startFix: { lat: DEMO_CENTER[1], lng: DEMO_CENTER[0], acc: 5, ts: '2026-10-12T02:00:00Z' }, tzOffsetMin: 330, quest: spec,
    });
    b.emit('ConnectivityChanged', { online: false, transport: 'none' }).wait(31 * 60, 20).complete();
    const s = summarizeSession(compiled, fold(compiled, b.build()), { userId: USER, challengeId: 'q', verified: true });
    const progress = evaluateMilestones(catalog, [s], { mode: 'final' });
    expect(progress.find((p) => p.key === '*@1:q_offline_30')!.tier).toBe('unlock');
    expect(progress.find((p) => p.key === '*@1:l_first_offline')!.tier).toBe('unlock');
    const prog = progression({ unlocks: unlocksOf(progress), summaries: [s], todayKey: s.dayKey });
    expect(prog.offlineQuestMinutes).toBeGreaterThanOrEqual(30);
    expect(prog.xp).toBeGreaterThanOrEqual(30 + 15);
  });

  it('a custom-module challenge still compiles alongside quests (registry isolation)', () => {
    expect(compile(challengeFromModule(defaultRegistry.get('football')!, { start: DEMO_CENTER, durationMin: 60, difficulty: 'medium' })).ok).toBe(true);
  });
});
