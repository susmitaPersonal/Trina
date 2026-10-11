import { definitionHash, uuidv7 } from '@trina/contracts';
import { compileOrThrow, evaluate, fold, wellness, type CompiledChallenge } from '@trina/engine';
import { SessionBuilder, fakeSha, greenSprintDefinition, greenSprintPoints } from '@trina/engine/fixtures';
import type { LiveSnapshot } from '../src/core/session-manager';

export const compiled: CompiledChallenge = compileOrThrow(greenSprintDefinition());
export const P = greenSprintPoints();
export const CHALLENGE_ID = '0192f000-0000-7000-8000-00000000c001';

export const storedChallenge = {
  id: CHALLENGE_ID,
  version: 1,
  title: 'Green Sprint 60',
  definitionHash: definitionHash(compiled.definition),
  maxScore: compiled.maxScore,
  engineMinVersion: 1,
  teamId: null,
  clockOffsetMs: 0,
  downloadedAt: new Date().toISOString(),
  stale: false,
  bundle: {
    challengeId: CHALLENGE_ID,
    version: 1,
    definition: compiled.definition,
    definitionHash: definitionHash(compiled.definition),
    engineMinVersion: 1,
    maxScore: compiled.maxScore,
    mapPack: null,
    ruleText: [],
    encouragement: [{ trigger: 'checkpoint', text: 'Nice!' }],
    participation: { teamId: null, joinedVersion: 1 },
    serverTime: new Date().toISOString(),
  },
};

/** A REAL engine snapshot: walked to cp1, now standing at cp2 with the litter task available. */
export function midRunSnapshot(stage: 'at_cp2' | 'finished' = 'at_cp2'): LiveSnapshot {
  const b = new SessionBuilder({ challengeId: CHALLENGE_ID, definitionHash: storedChallenge.definitionHash, userId: uuidv7(), deviceId: uuidv7(), start: P.start, sessionId: '0192f000-0000-7000-8000-00000000s001' });
  b.start().moveTo(P.cp1).wait(15).moveTo(P.cp2).wait(20);
  if (stage === 'finished') b.evidence('litter', fakeSha(1)).completeTask('litter', 10).moveTo(P.start).wait(10).complete();
  const events = b.build();
  const state = fold(compiled, events);
  const score = evaluate(compiled, state);
  return {
    sessionId: b.sessionId,
    challenge: storedChallenge as never,
    compiled,
    state,
    score,
    wellness: wellness(compiled, state),
    nowMono: state.lastMono,
    remainingMs: 35 * 60_000,
  };
}

export const counts = { pendingEvents: 0, pendingPhotos: 0, pendingOutbox: 0, failed: 0, waitingForWifi: 0 };

/** In-memory stand-in for getServices(): every method is a jest.fn you can override per test. */
export function fakeServices(overrides: Record<string, unknown> = {}) {
  const sm = {
    snapshot: jest.fn(async () => midRunSnapshot()),
    append: jest.fn(async () => ({})),
    setMood: jest.fn(async () => undefined),
    finish: jest.fn(async () => midRunSnapshot('finished')),
    abandon: jest.fn(async () => undefined),
    captureEvidence: jest.fn(async () => 'ev-1'),
    start: jest.fn(async () => 'session-1'),
    activeSessionId: jest.fn(async () => null),
    history: jest.fn(async () => []),
    impact: jest.fn(async () => ({ sessions: 2, trees: 4, litter: 20, distanceM: 4400, steps: 9000 })),
    events: jest.fn(async () => []),
  };
  const milestones = fakeMilestones();
  const confirmations = {
    ensureKeys: jest.fn(async () => ({ secretKeyHex: 'a'.repeat(64), publicKeyHex: 'b'.repeat(64) })),
    request: jest.fn(async () => 'TRINA1:request'),
    approve: jest.fn(async () => ({ qr: 'TRINA1:token', claims: [], request: {} })),
    accept: jest.fn(async () => ({ claims: [], issuerName: 'Meera', keyChecked: true })),
    list: jest.fn(async () => []),
  };
  return {
    db: { get: jest.fn(async () => null), all: jest.fn(async () => []), run: jest.fn(async () => ({ changes: 1 })), exec: jest.fn(), tx: jest.fn() },
    store: {
      getMeta: jest.fn(async () => null),
      setMeta: jest.fn(async () => undefined),
      getChallenge: jest.fn(async () => storedChallenge),
      listDownloaded: jest.fn(async () => [storedChallenge]),
      saveBundle: jest.fn(async () => storedChallenge),
      cacheLeaderboard: jest.fn(),
      cachedLeaderboard: jest.fn(async () => null),
      saveModule: jest.fn(async () => undefined),
      customModules: jest.fn(async () => []),
      moduleStatus: jest.fn(async () => null),
    },
    api: {
      login: jest.fn(),
      register: jest.fn(),
      serverTime: jest.fn(async () => ({ serverTime: new Date().toISOString() })),
      session: jest.fn(async () => {
        throw new Error('offline');
      }),
      createChallenge: jest.fn(async () => ({ id: 'new-challenge', version: 1, maxScore: 100 })),
      publish: jest.fn(async () => undefined),
      templates: jest.fn(async () => ({ items: [] })),
      request: jest.fn(async () => undefined),
      wellness: jest.fn(async () => ({ totals: {} })),
      modules: jest.fn(async () => []),
      myProgress: jest.fn(async () => {
        throw new Error('offline');
      }),
      moduleDraft: jest.fn(),
      moduleVersion: jest.fn(),
      createModule: jest.fn(),
      publishModule: jest.fn(async () => ({ status: 'active', visibility: 'private' })),
      forkModule: jest.fn(),
      reportModule: jest.fn(async () => undefined),
      myGuilds: jest.fn(async () => ({ items: [] })),
      guildBoard: jest.fn(),
      guildInvite: jest.fn(),
      joinGuild: jest.fn(async () => ({ guildId: 'g1' })),
      createGuild: jest.fn(async () => ({ id: 'g1', name: 'x' })),
      registerDeviceKey: jest.fn(async () => undefined),
    },
    sync: {
      runOnce: jest.fn(async () => ({ outcome: 'ok' })),
      counts: jest.fn(async () => counts),
      enqueue: jest.fn(async () => 'op-1'),
      retryFailed: jest.fn(async () => undefined),
    },
    deviceId: 'device-1',
    network: { online: true, wifi: true },
    quest: { active: false, sessionId: null as string | null },
    milestones: jest.fn(async () => milestones),
    confirmations: jest.fn(async () => confirmations),
    ensureDeviceKey: jest.fn(async () => undefined),
    ms: milestones,
    confirm: confirmations,
    photosOnCellular: { value: true },
    me: jest.fn(async () => ({ userId: 'u1', email: 'a@b.dev', displayName: 'Arjun', role: 'user', shareWellbeing: false })),
    setMe: jest.fn(async () => undefined),
    sessions: jest.fn(async () => sm),
    sm,
    ...overrides,
  };
}

/** Milestone service stand-in with realistic data (Daily Quests, progress, unlocks). */
export function fakeMilestones() {
  const progression = {
    xp: 120, xpByStat: { VIT: 60, AGI: 10, STR: 20, SENSE: 20, AURA: 10 }, rankPoints: 640, rank: 'D', nextRank: { rank: 'C', rankPoints: 1800 },
    verifiedOutdoorMinutes: 410, offlineQuestMinutes: 95, todayXp: 45, dailyXp: { '2026-10-12': 45 },
    weeks: { '2026-W42': { weekKey: '2026-W42', bonus: 0, penalty: 0, forceStopDays: 1, offline90Days: 1, xp: 45 } },
  };
  const unlock = { key: '*@1:q_offline_30', windowKey: '2026-10-12', tier: 'unlock', title: 'Finish a 30-min offline quest', value: 1, verification: 'sensor', label: 'Measured', stat: 'VIT', dayKey: '2026-10-12', status: 'provisional', unlockedAt: '2026-10-12T08:00:00.000Z', sources: ['0192f000-0000-7000-8000-00000000s001'] };
  const catchUnlock = { ...unlock, key: 'cricket@1:took_catch', windowKey: '2026-10-11', title: 'Took a catch', verification: 'peer', label: 'Confirmed', stat: 'AGI', dayKey: '2026-10-11', status: 'final' };
  const selfUnlock = { ...unlock, key: 'u_kite_flying_7f3a@1:trickster', title: 'Trickster', verification: 'self_report', label: 'Self-reported', stat: 'SENSE', status: 'final' };
  return {
    dailyQuests: jest.fn(async () => ({
      dayKey: '2026-10-12',
      levelTier: 'easy',
      targetMinutes: 30,
      quests: [
        { key: '*@1:q_offline_30', title: 'Finish a 30-min offline quest', stat: 'VIT', value: 1, target: 1, done: true, status: 'provisional' },
        { key: '*@1:q_steps_2000', title: 'Walk 2,000 steps', stat: 'VIT', value: 800, target: 2000, done: false, status: null },
        { key: '*@1:q_outside_45', title: 'Spend 45 min outside', stat: 'SENSE', value: 1200, target: 2700, done: false, status: null },
      ],
    })),
    current: jest.fn(async () => [
      { key: 'walking@1:steps_outside', moduleId: 'walking', milestoneId: 'steps_outside', title: 'Steps outside', window: 'day', windowKey: '2026-10-12', value: 2600, tier: 'bronze', tiersReached: ['bronze'], nextTier: { tier: 'silver', gte: 5000 }, verification: 'sensor', stat: 'VIT', dayKey: '2026-10-12', sources: [], pendingServer: false },
      { key: 'cricket@1:full_side', moduleId: 'cricket', milestoneId: 'full_side', title: 'Full side', window: 'session', windowKey: 's:x', value: 1, tier: null, tiersReached: [], nextTier: { tier: 'unlock', gte: 6 }, verification: 'sensor', stat: 'AURA', dayKey: '2026-10-12', sources: [], pendingServer: true },
    ]),
    progress: jest.fn(async () => ({ server: null, provisional: progression })),
    all: jest.fn(async (status?: string[]) => [unlock, catchUnlock, selfUnlock].filter((m) => !status || status.includes(m.status))),
    forSession: jest.fn(async () => [unlock]),
    evaluate: jest.fn(async () => []),
    evaluateLocal: jest.fn(async () => []),
    newlyFinal: jest.fn(async () => []),
    markNotified: jest.fn(async () => undefined),
    markFinalNotified: jest.fn(async () => undefined),
    applyProgress: jest.fn(async () => undefined),
    summaries: jest.fn(async () => []),
  };
}

