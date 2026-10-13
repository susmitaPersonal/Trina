import {
  canonicalJson,
  PARTY_MAX_MEMBERS,
  verifySummary,
  type ChallengeDefinitionInput,
  type LevelTier,
  type LngLat,
  type PartySpec,
  type PartySummary,
  type PartyTemplateId,
  type Rank,
  type TargetMinutes,
  type ThemeId,
} from '@trina/contracts';
import { round6 } from './geo';
import type { SessionSummary } from './milestones';
import { QUEST_GRACE_MIN } from './quests';
import type { Facts } from './types';

/**
 * Offline Party Mode (docs/architecture/offline-party-mode.md). Every phone in a party builds the
 * same definition from the host's signed PartySpec + start fix, so the definition hash matches with
 * no network. Party goals are evaluated from members' signed summaries; they feed milestones only,
 * never a challenge score or rank (ADR-033). Everything here is pure.
 */
export const PARTY_CHALLENGE_ID = '0192d41e-0000-7000-8000-000000000002';

type PartyTemplate = {
  title: string;
  /** Goal fact summed across members, its unit label, and the per-member share by tier. */
  goal: { fact: string; label: string; perMember: (spec: PartySpec) => number; value: (facts: Facts) => number };
  modules: string[];
  tasks: (spec: PartySpec) => NonNullable<ChallengeDefinitionInput['tasks']>;
  taskRules: (spec: PartySpec) => NonNullable<NonNullable<ChallengeDefinitionInput['scoring']>['rules']>;
};

const LITTER_PER_MEMBER: Record<LevelTier, number> = { easy: 5, medium: 8, hard: 12 };
const TREES_PER_MEMBER: Record<LevelTier, number> = { easy: 1, medium: 2, hard: 3 };
/** Time-outside share: 80 % of the target, so a short pause doesn't fail the party. */
const OUTSIDE_SHARE = 0.8;

export const PARTY_TEMPLATES: Record<PartyTemplateId, PartyTemplate> = {
  party_outside_v1: {
    title: 'Party outside',
    goal: {
      fact: 'zone_dwell_s',
      label: 'minutes outside',
      perMember: (spec) => Math.floor(spec.targetMinutes * OUTSIDE_SHARE),
      value: (f) => Math.floor(Number(f.zone_dwell_s ?? 0) / 60),
    },
    modules: ['walking'],
    tasks: () => [],
    taskRules: () => [],
  },
  party_cleanup_v1: {
    title: 'Party clean-up',
    goal: { fact: 'cleanup.items_collected', label: 'litter items', perMember: (spec) => LITTER_PER_MEMBER[spec.levelTier], value: (f) => Number(f['cleanup.items_collected'] ?? 0) },
    modules: ['walking', 'cleanup'],
    tasks: (spec) => [
      {
        id: 'litter',
        type: 'cleanup.collect_items',
        title: `Collect ${LITTER_PER_MEMBER[spec.levelTier]} litter items`,
        params: { quantity: LITTER_PER_MEMBER[spec.levelTier] },
        location: { kind: 'anywhere' },
        evidence: [{ kind: 'photo', count: 1, hint: 'Show the full bag of litter' }],
        required: false,
        scope: 'individual',
      },
    ],
    taskRules: () => [{ id: 'litter', kind: 'per_task', task: 'litter', points: 30 }],
  },
  party_trees_v1: {
    title: 'Party tree care',
    goal: { fact: 'tree_care.trees_watered', label: 'trees watered', perMember: (spec) => TREES_PER_MEMBER[spec.levelTier], value: (f) => Number(f['tree_care.trees_watered'] ?? 0) },
    modules: ['walking', 'tree_care'],
    tasks: (spec) =>
      Array.from({ length: TREES_PER_MEMBER[spec.levelTier] }, (_, i) => ({
        id: `tree${i + 1}`,
        type: 'tree_care.water_tree',
        title: `Water tree ${i + 1}`,
        params: {},
        location: { kind: 'anywhere' as const },
        evidence: [{ kind: 'photo' as const, count: 1, hint: 'Show the tree and the water' }],
        required: false,
        scope: 'individual' as const,
      })),
    taskRules: (spec) => Array.from({ length: TREES_PER_MEMBER[spec.levelTier] }, (_, i) => ({ id: `tree${i + 1}`, kind: 'per_task' as const, task: `tree${i + 1}`, points: 20 })),
  },
};

/** Theme names: words only. A theme never changes a number (ADR-032). */
export const THEME_TITLES: Record<ThemeId, string> = {
  tree_patrol: 'Tree Patrol',
  litter_hunters: 'Litter Hunters',
  river_guardians: 'River Guardians',
  park_explorers: 'Park Explorers',
  mindful_wanderers: 'Mindful Wanderers',
  sunrise_squad: 'Sunrise Squad',
};

export function buildPartyDefinition(spec: PartySpec, start: LngLat): ChallengeDefinitionInput {
  const t = PARTY_TEMPLATES[spec.templateId];
  if (!t) throw new Error(`Unknown party template "${String(spec.templateId)}"`);
  const center: LngLat = [round6(start[0]), round6(start[1])];
  const theme = spec.themeId ? THEME_TITLES[spec.themeId] : null;
  return {
    schemaVersion: '1.1',
    meta: {
      title: `${theme ?? t.title} · ${spec.targetMinutes} min`,
      description: `Offline party mission. Together: ${t.goal.perMember(spec)} ${t.goal.label} each. Internet off, go outside.`,
      tags: ['quest', 'party'],
      difficulty: spec.levelTier,
      visibility: 'private',
      language: 'en',
    },
    modules: t.modules.map((id) => ({ id, version: 1, params: {} })),
    mode: 'individual',
    participants: { min: 1, max: 1 },
    timing: { durationMin: spec.targetMinutes + QUEST_GRACE_MIN, startGraceMin: 0, daylightOnly: false },
    area: {
      startZone: { type: 'circle', center, radiusM: 75 },
      boundary: { type: 'circle', center, radiusM: 5000, graceM: 500 },
    },
    route: { type: 'free', checkpointIds: [] },
    checkpoints: [],
    tasks: t.tasks(spec),
    scoring: {
      rules: [...t.taskRules(spec), { id: 'outside', kind: 'metric_rate', metric: 'zone_dwell_s', pointsPer: 1, per: 60, cap: spec.targetMinutes }],
      bonuses: [],
      penalties: [],
      teamAggregation: 'sum',
    },
    completion: { all: [{ fact: 'duration_s', op: '>=', value: spec.targetMinutes * 60 }], endZoneRequired: false },
    safety: { noSpeedRewards: true },
  };
}

/** This member's contribution, for their own signed PartySummary. */
export function partyProgress(spec: PartySpec, facts: Facts): { goalValue: number; activeS: number; done: boolean } {
  const t = PARTY_TEMPLATES[spec.templateId];
  return { goalValue: Math.max(0, Math.floor(t.goal.value(facts))), activeS: Math.max(0, Math.floor(Number(facts.zone_dwell_s ?? 0))), done: facts.completed === true };
}

/* ------------------------------ gossip merge ------------------------------ */

/**
 * Gossip re-merges the same summaries many times; Ed25519 verification dominates the cost on a phone.
 * Results are cached by the FULL signed content (body + key + signature), so a changed body never hits
 * the cache. Bounded; the cache never changes a result, only skips repeated work.
 */
const verifiedCache = new Map<string, boolean>();
function verifiedSummary(s: PartySummary): boolean {
  const key = `${s.sig}|${s.publicKey}|${canonicalJson(s.body)}`;
  let ok = verifiedCache.get(key);
  if (ok === undefined) {
    ok = verifySummary(s);
    if (verifiedCache.size >= 512) verifiedCache.delete(verifiedCache.keys().next().value!);
    verifiedCache.set(key, ok);
  }
  return ok;
}

/** Higher seq wins; equal seq (a forked chain) is broken by chainHead so every phone picks the same one. */
function newer(a: PartySummary, b: PartySummary): PartySummary {
  if (a.body.seq !== b.body.seq) return a.body.seq > b.body.seq ? a : b;
  return a.body.chainHead >= b.body.chainHead ? a : b;
}

/**
 * Merges two sets of summaries: one entry per member (user), the newest wins. Invalid signatures and
 * other parties are dropped; at most PARTY_MAX_MEMBERS members (lowest user ids, so the cut is the same
 * everywhere). Commutative, associative and idempotent, so phones can exchange in any order.
 */
export function mergeSummaries(partyId: string, a: PartySummary[], b: PartySummary[]): PartySummary[] {
  const byUser = new Map<string, PartySummary>();
  for (const s of [...a, ...b]) {
    if (s.body.partyId !== partyId || !verifiedSummary(s)) continue;
    const cur = byUser.get(s.body.userId);
    byUser.set(s.body.userId, cur ? newer(cur, s) : s);
  }
  return [...byUser.values()].sort((x, y) => (x.body.userId < y.body.userId ? -1 : 1)).slice(0, PARTY_MAX_MEMBERS);
}

export type PartyGoalResult = {
  members: number;
  total: number;
  target: number;
  reached: boolean;
  membersDone: number;
  label: string;
  perMember: Array<{ userId: string; name: string; goalValue: number; done: boolean }>;
};

export type PartyContribution = { userId: string; name: string; goalValue: number; done: boolean };

/**
 * The party's shared goal: per-member share × members, summed contributions. Phones pass their merged
 * summaries' bodies (provisional); the server passes contributions from verified sessions only (final).
 */
export function evaluatePartyGoal(spec: PartySpec, contributions: PartyContribution[]): PartyGoalResult {
  const t = PARTY_TEMPLATES[spec.templateId];
  const members = contributions.length;
  const total = contributions.reduce((n, c) => n + c.goalValue, 0);
  const target = t.goal.perMember(spec) * members;
  return {
    members,
    total,
    target,
    reached: members >= 2 && total >= target,
    membersDone: contributions.filter((c) => c.done).length,
    label: t.goal.label,
    perMember: contributions.map((c) => ({ userId: c.userId, name: c.name, goalValue: c.goalValue, done: c.done })),
  };
}

/* ------------------------------ adaptive ladder (ADR-032) ------------------------------ */

export const QUEST_LADDER: TargetMinutes[] = [30, 45, 60, 90];
export const RANK_MAX_MINUTES: Record<Rank, TargetMinutes> = { E: 45, D: 45, C: 60, B: 90, A: 90, S: 90, Trina: 90 };
export const TIER_FOR_MINUTES: Record<TargetMinutes, LevelTier> = { 30: 'easy', 45: 'medium', 60: 'medium', 90: 'hard' };
const LADDER_WINDOW_DAYS = 14;
const RETURN_AFTER_DAYS = 7;

export type AdaptReason = 'start' | 'welcome_back' | 'step_up' | 'step_down' | 'stay' | 'rank_cap';
export type AdaptedQuest = { targetMinutes: TargetMinutes; levelTier: LevelTier; reason: AdaptReason };

const dayNum = (dayKey: string) => Math.round(Date.parse(`${dayKey}T00:00:00Z`) / 86_400_000);

/**
 * Picks the next quest size from measured history (pure, deterministic). Safety stops never count
 * against the player; the rank caps how far the ladder goes.
 */
export function adaptQuest(history: SessionSummary[], ctx: { rank: Rank; todayKey: string }): AdaptedQuest {
  const today = dayNum(ctx.todayKey);
  const cap = QUEST_LADDER.indexOf(RANK_MAX_MINUTES[ctx.rank]);
  const quests = history
    .filter((s) => s.isQuest && s.questTargetMin !== undefined && QUEST_LADDER.includes(s.questTargetMin as TargetMinutes))
    .filter((s) => dayNum(s.dayKey) <= today)
    .sort((a, b) => a.startMs - b.startMs || (a.sessionId < b.sessionId ? -1 : 1));
  const out = (i: number, reason: AdaptReason): AdaptedQuest => {
    const capped = Math.min(Math.max(i, 0), cap);
    const m = QUEST_LADDER[capped]!;
    return { targetMinutes: m, levelTier: TIER_FOR_MINUTES[m], reason: capped < i ? 'rank_cap' : reason };
  };
  if (!quests.length) return out(0, 'start');
  const last = quests[quests.length - 1]!;
  if (today - dayNum(last.dayKey) >= RETURN_AFTER_DAYS) return out(0, 'welcome_back');

  const current = QUEST_LADDER.indexOf(last.questTargetMin as TargetMinutes);
  const recent = quests.filter((s) => today - dayNum(s.dayKey) < LADDER_WINDOW_DAYS);
  const forceStops = recent.filter((s) => s.questStop === 'force').length;
  const short = recent.filter((s) => s.questStop !== 'safety' && s.status !== 'active' && Number(s.facts.offline_s ?? 0) < (s.questTargetMin! * 60) / 2).length;
  if (forceStops >= 2 || short >= 2) return out(current - 1, 'step_down');

  // Completed quests at the current tier since the last tier change.
  let streak = 0;
  for (let i = recent.length - 1; i >= 0 && recent[i]!.questTargetMin === last.questTargetMin; i--) {
    const s = recent[i]!;
    if (s.status === 'completed' && s.questStop === null) streak++;
  }
  if (streak >= 3) return out(current + 1, 'step_up');
  return out(current, 'stay');
}
