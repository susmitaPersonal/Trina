import type { MilestoneWindow, TierName, Verification } from '@trina/contracts';
import { computeFacts, evalCondition, type EvaluateContext } from './evaluate';
import { compileMilestone } from './milestone-compile';
import { GENERIC_MILESTONES } from './modules/descriptors';
import type { CompiledChallenge, CompiledMilestone, FactValue, ModuleRegistry, SessionState } from './types';

/**
 * Milestones are DERIVED data (ADR-024): never events, always recomputable from session summaries.
 * Everything here is pure: same summaries → same progress, on the phone and on the server.
 */

/* ------------------------------ day / week keys ------------------------------ */

export const DAY_BOUNDARY_HOUR = 4;

/** Local date of (instant − 4 h) in the given UTC offset (ADR-025). Format YYYY-MM-DD. */
export function dayKeyOf(epochMs: number, tzOffsetMin: number): string {
  return new Date(epochMs + tzOffsetMin * 60_000 - DAY_BOUNDARY_HOUR * 3_600_000).toISOString().slice(0, 10);
}

/** ISO week (Monday start) of a day key, e.g. 2026-W42. */
export function weekKeyOf(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  const dayNum = d.getUTCDay() || 7; // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday of this week decides the year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function monthKeyOf(dayKey: string): string {
  return dayKey.slice(0, 7);
}

export function addDays(dayKey: string, n: number): string {
  return new Date(Date.parse(`${dayKey}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/* ------------------------------ session summary ------------------------------ */

/** Compact, privacy-friendly per-session input to the evaluator (~1 KB). No coordinates. */
export type SessionSummary = {
  sessionId: string;
  userId: string;
  challengeId: string;
  moduleIds: string[];
  /** Module versions this session used (custom modules are versioned; milestones pin them). */
  moduleVersions: Record<string, number>;
  startMs: number;
  /** UTC offset used for the day key (minutes). */
  tzOffsetMin: number;
  dayKey: string;
  weekKey: string;
  monthKey: string;
  /** True when the time zone was not recorded (old app): the day key is an approximation. */
  dayKeyApprox: boolean;
  facts: Record<string, FactValue>;
  factLevels: Record<string, Verification>;
  /** `<challengeId>:<checkpointId|zone>` ids, never coordinates. */
  placeKeys: string[];
  /** Places per fact-bearing task (for samePlace streaks and distinct places). */
  zoneIntervalsMs: Array<[number, number]>;
  status: 'completed' | 'abandoned' | 'active';
  questStop: 'force' | 'safety' | null;
  isQuest: boolean;
  /** Target minutes of an offline quest (adaptive ladder, ADR-032). Absent for older stored summaries. */
  questTargetMin?: number;
  /** Offline Party id (ADR-033). Absent when not a party session. */
  partyId?: string;
  /** Final (server-validated) and counted. Provisional summaries are false. */
  verified: boolean;
};

export type SummaryContext = EvaluateContext & {
  userId: string;
  challengeId: string;
  verified: boolean;
  /** Server clock correction applied when the temporal stage flagged drift (ADR-025 rule 3). */
  clockCorrectionMs?: number;
  /** Fallback time zone for old apps that didn't record one. */
  fallbackTzOffsetMin?: number;
};

export function summarizeSession(compiled: CompiledChallenge, s: SessionState, ctx: SummaryContext): SessionSummary {
  const facts = computeFacts(compiled, s, ctx);
  const startMs = (s.startClientTs ? Date.parse(s.startClientTs) : 0) + (ctx.clockCorrectionMs ?? 0);
  const tz = s.tzOffsetMin ?? ctx.fallbackTzOffsetMin ?? 0;
  const dayKey = dayKeyOf(startMs, tz);
  const places = new Set<string>();
  for (const [id, cp] of Object.entries(s.checkpoints)) if (cp.reached) places.add(`${ctx.challengeId}:${id}`);
  for (const ev of Object.values(s.evidence)) if (ev.checkpointId && !ev.invalidReason && !ctx.invalidEvidence?.[ev.evidenceId]) places.add(`${ctx.challengeId}:${ev.checkpointId}`);
  if (s.zoneDwellMs > 0 && !compiled.checkpoints.size) places.add(`${ctx.challengeId}:zone`);
  const startMono = s.startMono ?? 0;
  const kept: Record<string, FactValue> = {};
  for (const [k, v] of Object.entries(facts)) if (!k.startsWith('checkpoint.') && !k.startsWith('task.')) kept[k] = v;
  return {
    sessionId: s.sessionId ?? '',
    userId: ctx.userId,
    challengeId: ctx.challengeId,
    moduleIds: compiled.modules.map((m) => m.id),
    moduleVersions: Object.fromEntries(compiled.modules.map((m) => [m.id, m.version])),
    startMs,
    tzOffsetMin: tz,
    dayKey,
    weekKey: weekKeyOf(dayKey),
    monthKey: monthKeyOf(dayKey),
    dayKeyApprox: s.tzOffsetMin === null,
    facts: kept,
    factLevels: compiled.factLevels,
    placeKeys: [...places].sort(),
    zoneIntervalsMs: s.zoneIntervals.map(([a, b]) => [startMs + (a - startMono), startMs + (b - startMono)] as [number, number]),
    status: s.status === 'completed' ? 'completed' : s.status === 'abandoned' ? 'abandoned' : 'active',
    questStop: s.questStop,
    isQuest: s.quest !== null,
    ...(s.quest ? { questTargetMin: s.quest.targetMinutes } : {}),
    ...(s.party ? { partyId: s.party.partyId } : {}),
    verified: ctx.verified,
  };
}

/* ------------------------------ catalogue ------------------------------ */

/** All milestones: the generic quests (module '*') + every module's own milestones. */
export function buildMilestoneCatalog(registry: ModuleRegistry): CompiledMilestone[] {
  const out: CompiledMilestone[] = [];
  for (const def of GENERIC_MILESTONES) {
    const r = compileMilestone(def, { moduleId: '*', moduleVersion: 1, factLevels: {}, movement: null });
    if (!r.ok) throw new Error(`Generic milestone ${String((def as { id: string }).id)} does not compile: ${r.issues.map((i) => i.message).join(', ')}`);
    out.push(r.milestone);
  }
  for (const m of registry.list()) {
    for (const def of m.descriptor?.milestones ?? []) {
      const r = compileMilestone(def, { moduleId: m.id, moduleVersion: m.version, factLevels: m.factLevels ?? {}, movement: m.descriptor?.movement ?? null, counterMax: Object.fromEntries((m.counters ?? []).map((c) => [`${m.id}.${c.id}`, c.maxPerSession])) });
      if (r.ok) out.push(r.milestone);
    }
  }
  return out;
}

/* ------------------------------ evaluation ------------------------------ */

export type MilestoneProgress = {
  key: string;
  moduleId: string;
  milestoneId: string;
  title: string;
  window: MilestoneWindow;
  windowKey: string;
  value: number;
  /** Highest tier reached (null = in progress). */
  tier: TierName | null;
  tiersReached: TierName[];
  nextTier: { tier: TierName; gte: number } | null;
  verification: Verification;
  stat: CompiledMilestone['def']['stat'];
  /** The day this window's progress belongs to (last contributing session). */
  dayKey: string;
  sources: string[];
  /** Needs a server-only fact (co-presence) that the phone can't compute. */
  pendingServer: boolean;
};

export type EvaluateMilestonesOptions = {
  /** `final`: only verified summaries count (server). `provisional`: everything on the phone. */
  mode: 'provisional' | 'final';
  /** Server-only facts by session (e.g. co-presence). */
  serverFacts?: Record<string, Record<string, number>>;
};

function windowKey(w: MilestoneWindow, s: SessionSummary): string {
  return w === 'session' ? `s:${s.sessionId}` : w === 'day' ? s.dayKey : w === 'week' ? s.weekKey : w === 'month' ? s.monthKey : 'life';
}

function factOf(s: SessionSummary, fact: string, serverFacts?: EvaluateMilestonesOptions['serverFacts']): number {
  const v = serverFacts?.[s.sessionId]?.[fact] ?? s.facts[fact];
  return typeof v === 'number' ? v : v === true ? 1 : 0;
}

/** Longest run of qualifying days; up to `rest` missed days per ISO week don't break it (and don't count). */
export function longestStreak(days: string[], rest: number): number {
  const sorted = [...new Set(days)].sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  const restUsed = new Map<string, number>();
  for (const d of sorted) {
    if (prev === null) run = 1;
    else {
      let gapOk = true;
      for (let g = addDays(prev, 1); g < d; g = addDays(g, 1)) {
        const wk = weekKeyOf(g);
        const used = restUsed.get(wk) ?? 0;
        if (used >= rest) {
          gapOk = false;
          break;
        }
        restUsed.set(wk, used + 1);
      }
      if (gapOk) run += 1;
      else {
        run = 1;
        restUsed.clear();
      }
    }
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

export function evaluateMilestones(catalog: CompiledMilestone[], summaries: SessionSummary[], opts: EvaluateMilestonesOptions): MilestoneProgress[] {
  const pool = summaries.filter((s) => (opts.mode === 'final' ? s.verified : true));
  const out: MilestoneProgress[] = [];
  for (const m of catalog) {
    const d = m.def;
    const relevant = pool.filter((s) => (m.moduleId === '*' || s.moduleIds.includes(m.moduleId)) && (!d.where || evalCondition(d.where, { ...s.facts, ...(opts.serverFacts?.[s.sessionId] ?? {}) })));
    const groups = new Map<string, SessionSummary[]>();
    for (const s of relevant) {
      const k = windowKey(d.window, s);
      groups.set(k, [...(groups.get(k) ?? []), s]);
    }
    for (const [wk, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const ordered = [...group].sort((a, b) => a.startMs - b.startMs || a.sessionId.localeCompare(b.sessionId));
      const meas = d.measure;
      let value = 0;
      if (meas.agg === 'sum') value = ordered.reduce((n, s) => n + factOf(s, meas.fact, opts.serverFacts), 0);
      else if (meas.agg === 'max') value = ordered.reduce((n, s) => Math.max(n, factOf(s, meas.fact, opts.serverFacts)), 0);
      else if (meas.agg === 'sessions') value = ordered.length;
      else if (meas.agg === 'days' || meas.agg === 'streak_days') {
        const perDay = new Map<string, number>();
        const perPlaceDay = new Map<string, Map<string, number>>();
        for (const s of ordered) {
          const v = factOf(s, meas.fact, opts.serverFacts);
          perDay.set(s.dayKey, (perDay.get(s.dayKey) ?? 0) + v);
          for (const p of s.placeKeys) {
            const m2 = perPlaceDay.get(p) ?? new Map<string, number>();
            m2.set(s.dayKey, (m2.get(s.dayKey) ?? 0) + v);
            perPlaceDay.set(p, m2);
          }
        }
        if (meas.agg === 'days') value = [...perDay.values()].filter((v) => v >= meas.perDayGte).length;
        else if (meas.samePlace) {
          for (const days of perPlaceDay.values()) value = Math.max(value, longestStreak([...days.entries()].filter(([, v]) => v >= meas.perDayGte).map(([k]) => k), meas.restDaysPerWeek));
        } else value = longestStreak([...perDay.entries()].filter(([, v]) => v >= meas.perDayGte).map(([k]) => k), meas.restDaysPerWeek);
      } else {
        const perPlace = new Map<string, number>();
        for (const s of ordered) for (const p of s.placeKeys) perPlace.set(p, (perPlace.get(p) ?? 0) + factOf(s, meas.fact, opts.serverFacts));
        value = [...perPlace.values()].filter((v) => v >= meas.perPlaceGte).length;
      }
      if (value <= 0) continue;
      const reached = d.tiers.filter((t) => value >= t.gte);
      const next = d.tiers.find((t) => value < t.gte) ?? null;
      const factName = 'fact' in meas ? meas.fact : null;
      const pendingServer = m.serverOnly && !ordered.some((s) => factName && opts.serverFacts?.[s.sessionId]?.[factName] !== undefined);
      out.push({
        key: m.key,
        moduleId: m.moduleId,
        milestoneId: d.id,
        title: d.title,
        window: d.window,
        windowKey: wk,
        value,
        tier: reached.length ? reached[reached.length - 1]!.tier : null,
        tiersReached: reached.map((t) => t.tier),
        nextTier: next ? { tier: next.tier, gte: next.gte } : null,
        verification: m.verification,
        stat: d.stat,
        dayKey: ordered[ordered.length - 1]!.dayKey,
        sources: ordered.map((s) => s.sessionId),
        pendingServer,
      });
    }
  }
  return out;
}

/** Unlock rows (one per tier reached): the unit of "exactly once". */
export type MilestoneUnlock = { key: string; windowKey: string; tier: TierName; verification: Verification; stat: MilestoneProgress['stat']; dayKey: string; title: string };

export function unlocksOf(progress: MilestoneProgress[]): MilestoneUnlock[] {
  return progress
    .filter((p) => !p.pendingServer)
    .flatMap((p) => p.tiersReached.map((tier) => ({ key: p.key, windowKey: p.windowKey, tier, verification: p.verification, stat: p.stat, dayKey: p.dayKey, title: p.title })));
}

export const unlockId = (u: Pick<MilestoneUnlock, 'key' | 'windowKey' | 'tier'>) => `${u.key}|${u.windowKey}|${u.tier}`;

/* ------------------------------ co-presence (server) ------------------------------ */

/**
 * Number of distinct players co-present with each session (including itself): two sessions of the
 * SAME challenge whose in-zone intervals overlap for ≥ `minOverlapMs`. Never compares strangers
 * across challenges.
 */
export function coPresence(summaries: SessionSummary[], minOverlapMs = 600_000): Record<string, number> {
  const out: Record<string, number> = {};
  const byChallenge = new Map<string, SessionSummary[]>();
  for (const s of summaries) byChallenge.set(s.challengeId, [...(byChallenge.get(s.challengeId) ?? []), s]);
  const overlap = (a: Array<[number, number]>, b: Array<[number, number]>) => {
    let t = 0;
    for (const [x1, x2] of a) for (const [y1, y2] of b) t += Math.max(0, Math.min(x2, y2) - Math.max(x1, y1));
    return t;
  };
  for (const group of byChallenge.values()) {
    for (const s of group) {
      const users = new Set<string>([s.userId]);
      for (const o of group) if (o.userId !== s.userId && overlap(s.zoneIntervalsMs, o.zoneIntervalsMs) >= minOverlapMs) users.add(o.userId);
      out[s.sessionId] = users.size;
    }
  }
  return out;
}
