import { z } from 'zod';
import { IsoDateTime } from './common';
import { Stat, TierName, Verification } from './module-definition';

/** Ranks (ADR-024). Rank never goes down. */
export const Rank = z.enum(['E', 'D', 'C', 'B', 'A', 'S', 'Trina']);
export type Rank = z.infer<typeof Rank>;

/** Shown on every badge (design §3.5). */
export const VerificationLabel = z.enum(['Measured', 'Evidenced', 'Confirmed', 'Self-reported', 'Checked after sync']);
export type VerificationLabel = z.infer<typeof VerificationLabel>;

export const MilestoneStatus = z.enum(['provisional', 'final', 'revoked', 'pending_server']);
export type MilestoneStatus = z.infer<typeof MilestoneStatus>;

export const MilestoneProgressDto = z.object({
  /** `<moduleId>@<version>:<milestoneId>` (module '*' for the generic catalogue). */
  key: z.string().max(80),
  moduleId: z.string().max(40),
  milestoneId: z.string().max(40),
  title: z.string().max(60),
  windowKey: z.string().max(60),
  /** Highest tier reached in this window, or null when still in progress. */
  tier: TierName.nullable(),
  value: z.number(),
  nextTier: z.object({ tier: TierName, gte: z.number() }).nullable(),
  verification: Verification,
  label: VerificationLabel,
  stat: Stat,
  status: MilestoneStatus,
  unlockedAt: IsoDateTime.nullable(),
});
export type MilestoneProgressDto = z.infer<typeof MilestoneProgressDto>;

export const ProgressDto = z.object({
  xp: z.int(),
  xpByStat: z.record(Stat, z.int()),
  rankPoints: z.int(),
  rank: Rank,
  nextRank: z.object({ rank: Rank, rankPoints: z.int() }).nullable(),
  verifiedOutdoorMinutes: z.int(),
  offlineQuestMinutes: z.int(),
  todayXp: z.int(),
  dailyXpCap: z.int(),
  week: z.object({
    weekKey: z.string(),
    bonus: z.int(),
    penalty: z.int(),
    forceStopDays: z.int(),
    offline90Days: z.int(),
  }),
  engineVersion: z.int(),
});
export type ProgressDto = z.infer<typeof ProgressDto>;

export const DailyQuestDto = z.object({
  dayKey: z.string(),
  levelTier: z.enum(['easy', 'medium', 'hard']),
  /** Suggested length from the adaptive ladder (ADR-032); the player may pick any length up to their rank cap. */
  targetReason: z.enum(['start', 'welcome_back', 'step_up', 'step_down', 'stay', 'rank_cap']).optional(),
  maxMinutes: z.int().optional(),
  targetMinutes: z.union([z.literal(30), z.literal(45), z.literal(60), z.literal(90)]),
  quests: z.array(z.object({ key: z.string(), title: z.string(), stat: Stat })),
});
export type DailyQuestDto = z.infer<typeof DailyQuestDto>;
