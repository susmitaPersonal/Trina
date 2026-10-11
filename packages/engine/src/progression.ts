import type { Rank, Stat, TierName } from '@trina/contracts';
import { weekKeyOf, type MilestoneUnlock, type SessionSummary } from './milestones';

/**
 * Progression rules (design §4.4, owner decisions 2026-10-10/11). Fixed in code, never in data:
 * XP and rank NEVER feed challenge score; self-reports earn titles only; rank comes only from
 * verified activity minutes, offline quest time and photo proof; rank never goes down.
 */
export const TIER_XP: Record<TierName, number> = { unlock: 15, bronze: 10, silver: 25, gold: 50 };
export const DAILY_XP_CAP = 300;
/** Offline quest minutes earn XP from 30 to 90 per day (below 30: none; above 90: nothing more). */
export const QUEST_MIN_MINUTES = 30;
export const QUEST_MAX_MINUTES = 90;
export const WEEKLY_OFFLINE_BONUS = 15;
export const WEEKLY_OFFLINE_DAYS = 3;
export const FORCE_STOP_PENALTY = 10;
export const FORCE_STOP_DAYS = 3;
export const PHOTO_RP = 5;
export const PHOTO_RP_MAX_PER_DAY = 5;

export const RANKS: Rank[] = ['E', 'D', 'C', 'B', 'A', 'S', 'Trina'];
export const RANK_THRESHOLDS: Record<Rank, number> = { E: 0, D: 600, C: 1800, B: 4800, A: 12_000, S: 30_000, Trina: 60_000 };
/** B and above also need this many Evidenced (photo) AURA milestones. */
export const AURA_EVIDENCED_FOR_B = 3;

export type ProgressionInput = {
  unlocks: MilestoneUnlock[];
  /** All of the player's summaries (verified ones count for XP/RP; force stops count regardless). */
  summaries: SessionSummary[];
  todayKey: string;
  previousRank?: Rank | null;
};

export type WeekResult = { weekKey: string; bonus: number; penalty: number; forceStopDays: number; offline90Days: number; xp: number };

export type Progression = {
  xp: number;
  xpByStat: Record<Stat, number>;
  rankPoints: number;
  rank: Rank;
  nextRank: { rank: Rank; rankPoints: number } | null;
  verifiedOutdoorMinutes: number;
  offlineQuestMinutes: number;
  todayXp: number;
  dailyXp: Record<string, number>;
  weeks: Record<string, WeekResult>;
};

const STATS: Stat[] = ['VIT', 'AGI', 'STR', 'SENSE', 'AURA'];

export function progression(input: ProgressionInput): Progression {
  const verified = input.summaries.filter((s) => s.verified);
  const xpByStat = Object.fromEntries(STATS.map((s) => [s, 0])) as Record<Stat, number>;

  // Raw daily XP before caps: milestone tiers (self-reports earn none) + offline quest minutes.
  const daily = new Map<string, { xp: number; byStat: Partial<Record<Stat, number>> }>();
  const add = (day: string, stat: Stat, xp: number) => {
    const d = daily.get(day) ?? { xp: 0, byStat: {} };
    d.xp += xp;
    d.byStat[stat] = (d.byStat[stat] ?? 0) + xp;
    daily.set(day, d);
  };
  for (const u of input.unlocks) if (u.verification !== 'self_report') add(u.dayKey, u.stat, TIER_XP[u.tier]);
  const offlineMinByDay = new Map<string, number>();
  for (const s of verified) if (s.isQuest) offlineMinByDay.set(s.dayKey, (offlineMinByDay.get(s.dayKey) ?? 0) + Math.floor(Number(s.facts.offline_s ?? 0) / 60));
  for (const [day, min] of offlineMinByDay) if (min >= QUEST_MIN_MINUTES) add(day, 'VIT', Math.min(min, QUEST_MAX_MINUTES));

  // Daily cap, applied proportionally to stats so stats always sum to XP.
  const dailyXp: Record<string, number> = {};
  for (const [day, d] of [...daily.entries()].sort()) {
    const capped = Math.min(DAILY_XP_CAP, d.xp);
    dailyXp[day] = capped;
    let assigned = 0;
    const entries = STATS.filter((s) => d.byStat[s]);
    entries.forEach((s, i) => {
      const share = i === entries.length - 1 ? capped - assigned : Math.floor(((d.byStat[s] ?? 0) * capped) / Math.max(1, d.xp));
      xpByStat[s] += share;
      assigned += share;
    });
  }

  // Weeks: +15 for 3+ days with ≥ 90 offline minutes; −10 for force stops on 3+ days; weekly XP never below 0.
  const weeks: Record<string, WeekResult> = {};
  const weekOf = (day: string) => (weeks[weekKeyOf(day)] ??= { weekKey: weekKeyOf(day), bonus: 0, penalty: 0, forceStopDays: 0, offline90Days: 0, xp: 0 });
  for (const [day, xp] of Object.entries(dailyXp)) weekOf(day).xp += xp;
  for (const [day, min] of offlineMinByDay) if (min >= QUEST_MAX_MINUTES) weekOf(day).offline90Days++;
  const forceDays = new Set(input.summaries.filter((s) => s.isQuest && s.questStop === 'force').map((s) => s.dayKey));
  for (const day of forceDays) weekOf(day).forceStopDays++;
  let xp = 0;
  for (const w of Object.values(weeks)) {
    if (w.offline90Days >= WEEKLY_OFFLINE_DAYS) {
      w.bonus = WEEKLY_OFFLINE_BONUS;
      xpByStat.VIT += WEEKLY_OFFLINE_BONUS;
    }
    if (w.forceStopDays >= FORCE_STOP_DAYS) {
      w.penalty = Math.min(FORCE_STOP_PENALTY, w.xp + w.bonus);
      // Take the penalty from the largest stats first; stats never go negative.
      let left = w.penalty;
      for (const s of [...STATS].sort((a, b) => xpByStat[b] - xpByStat[a] || a.localeCompare(b))) {
        const take = Math.min(left, xpByStat[s]);
        xpByStat[s] -= take;
        left -= take;
      }
    }
    w.xp = Math.max(0, w.xp + w.bonus - w.penalty);
    xp += w.xp;
  }

  // Rank points: activity minutes + offline quest minutes (counted twice) + photo proof. Never confirmations.
  let rankPoints = 0;
  let outdoorMin = 0;
  let offlineMin = 0;
  const photosByDay = new Map<string, number>();
  for (const s of verified) {
    const outdoor = Math.floor(Number(s.facts.zone_dwell_s ?? 0) / 60);
    const off = s.isQuest ? Math.floor(Number(s.facts.offline_s ?? 0) / 60) : 0;
    outdoorMin += outdoor;
    offlineMin += off;
    rankPoints += outdoor + off;
    photosByDay.set(s.dayKey, (photosByDay.get(s.dayKey) ?? 0) + Number(s.facts.photo_proofs ?? 0));
  }
  for (const n of photosByDay.values()) rankPoints += Math.min(PHOTO_RP_MAX_PER_DAY, n) * PHOTO_RP;

  const auraEvidenced = new Set(input.unlocks.filter((u) => u.stat === 'AURA' && u.verification === 'photo').map((u) => `${u.key}|${u.windowKey}`)).size;
  let rank: Rank = verified.length ? 'E' : 'E';
  for (const r of RANKS) {
    if (rankPoints < RANK_THRESHOLDS[r]) break;
    if (RANKS.indexOf(r) >= RANKS.indexOf('B') && auraEvidenced < AURA_EVIDENCED_FOR_B) break;
    rank = r;
  }
  if (input.previousRank && RANKS.indexOf(input.previousRank) > RANKS.indexOf(rank)) rank = input.previousRank; // never goes down
  const next = RANKS[RANKS.indexOf(rank) + 1];

  return {
    xp,
    xpByStat,
    rankPoints,
    rank,
    nextRank: next ? { rank: next, rankPoints: RANK_THRESHOLDS[next] } : null,
    verifiedOutdoorMinutes: outdoorMin,
    offlineQuestMinutes: offlineMin,
    todayXp: dailyXp[input.todayKey] ?? 0,
    dailyXp,
    weeks,
  };
}

/** Quest length by level: beginner 30, mid 45, pro 90 minutes (design §3.7). */
export function levelTierForRank(rank: Rank): { levelTier: 'easy' | 'medium' | 'hard'; targetMinutes: 30 | 45 | 90 } {
  const i = RANKS.indexOf(rank);
  return i <= 1 ? { levelTier: 'easy', targetMinutes: 30 } : i <= 3 ? { levelTier: 'medium', targetMinutes: 45 } : { levelTier: 'hard', targetMinutes: 90 };
}
