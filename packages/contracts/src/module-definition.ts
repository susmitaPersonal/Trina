import { z } from 'zod';
import { ConditionSchema } from './challenge-definition';

/**
 * Module Definition DSL v1 (docs/architecture/milestones-and-custom-modules.md §2, ADR-023).
 * Declarative DATA interpreted by the engine. Closed vocabularies only: no code, no expressions
 * as strings, no URLs. Points and speeds are never chosen by authors (weights + fixed tables).
 */
export const MODULE_DSL_VERSION = 'module/1.0' as const;

export const Movement = z.enum(['on_foot', 'human_powered_wheels', 'stationary_play', 'mixed_play']);
export type Movement = z.infer<typeof Movement>;

/** No rooftop, road, water, rail or private venues exist (safety by vocabulary). */
export const Venue = z.enum(['open_ground', 'park', 'court', 'walkable_street', 'beach', 'wetland', 'garden', 'any_public']);
export type Venue = z.infer<typeof Venue>;

export const ModuleOrigin = z.enum(['builtin', 'official', 'community']);
export type ModuleOrigin = z.infer<typeof ModuleOrigin>;

export const MODULE_ICONS = [
  'walk', 'run', 'bike', 'broom', 'tree', 'lotus', 'search', 'muscle', 'cricket', 'football', 'badminton', 'tennis',
  'basketball', 'volleyball', 'frisbee', 'kite', 'bird', 'leaf', 'flower', 'sun', 'yoga', 'chess', 'skate', 'hike',
  'camera', 'book', 'music', 'paint', 'water', 'recycle', 'heart', 'star', 'flag', 'map', 'compass', 'ball', 'park', 'garden',
] as const;
export const ModuleIcon = z.enum(MODULE_ICONS);

export const ModuleTag = z.enum(['team_sport', 'ball', 'racket', 'social', 'open_air', 'nature', 'civic', 'mindful', 'fitness', 'creative', 'kids_friendly']);
export const ParamUnit = z.enum(['minutes', 'metres', 'count', 'overs', 'players']);
export const CounterUnit = z.enum(['count', 'overs', 'points', 'laps', 'rounds', 'species', 'minutes']);
export type CounterUnit = z.infer<typeof CounterUnit>;

/** How a fact is known (strongest first). */
export const Verification = z.enum(['sensor', 'photo', 'organizer', 'peer', 'self_report']);
export type Verification = z.infer<typeof Verification>;
/** Counters can never be sensor-verified: a person (or nobody) vouches for them. */
export const ClaimVerification = z.enum(['organizer', 'peer', 'self_report']);
export type ClaimVerification = z.infer<typeof ClaimVerification>;

export const TaskCompletion = z.enum(['evidence', 'self_report', 'confirmation']);
export type TaskCompletion = z.infer<typeof TaskCompletion>;

export const ChecklistItem = z.enum(['helmet_on', 'brakes_checked', 'water_bottle', 'buddy_present', 'sun_protection', 'shoes_on', 'warm_up', 'first_aid_known']);
export type ChecklistItem = z.infer<typeof ChecklistItem>;
export const SafetyNote = z.enum([
  'hard_ball_needs_guard', 'no_glass_coated_string', 'stay_off_rooftops', 'away_from_power_lines', 'stay_on_footpaths',
  'no_swimming', 'keep_distance_from_animals', 'heat_take_breaks', 'daylight_only', 'respect_wildlife', 'no_road_racing',
]);
export type SafetyNote = z.infer<typeof SafetyNote>;

export const Stat = z.enum(['VIT', 'AGI', 'STR', 'SENSE', 'AURA']);
export type Stat = z.infer<typeof Stat>;

const Ident = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/);
const Label = (max: number) => z.string().trim().min(2).max(max);

/* ------------------------------------------------------------------ */
/* Milestone DSL (§3)                                                  */
/* ------------------------------------------------------------------ */

export const MilestoneWindow = z.enum(['session', 'day', 'week', 'month', 'lifetime']);
export type MilestoneWindow = z.infer<typeof MilestoneWindow>;

const FactName = z.string().min(1).max(64);

export const MilestoneMeasure = z.discriminatedUnion('agg', [
  z.object({ agg: z.literal('sum'), fact: FactName }),
  z.object({ agg: z.literal('max'), fact: FactName }),
  z.object({ agg: z.literal('sessions') }),
  z.object({ agg: z.literal('days'), fact: FactName, perDayGte: z.number().min(1).max(1_000_000) }),
  z.object({
    agg: z.literal('streak_days'),
    fact: FactName,
    perDayGte: z.number().min(1).max(1_000_000),
    restDaysPerWeek: z.int().min(0).max(2).default(1),
    samePlace: z.boolean().default(false),
  }),
  z.object({ agg: z.literal('distinct_places'), fact: FactName, perPlaceGte: z.number().min(1).max(1_000_000) }),
]);
export type MilestoneMeasure = z.infer<typeof MilestoneMeasure>;

export const TierName = z.enum(['unlock', 'bronze', 'silver', 'gold']);
export type TierName = z.infer<typeof TierName>;
export const MilestoneTier = z.object({ tier: TierName, gte: z.number().min(1).max(1_000_000) });

export const MilestoneDefinition = z
  .object({
    id: z.string().regex(/^[a-z0-9_]{2,32}$/),
    /** Module id, or '*' for cross-module (built-in catalogue only). */
    module: z.string().regex(/^(\*|[a-z][a-z0-9_]{1,31})$/).optional(),
    title: Label(40),
    description: z.string().trim().max(120).optional(),
    window: MilestoneWindow,
    measure: MilestoneMeasure,
    where: ConditionSchema.optional(),
    tiers: z.array(MilestoneTier).min(1).max(3),
    scope: z.enum(['individual', 'team']).default('individual'),
    stat: Stat,
    hidden: z.boolean().default(false),
  })
  .strict()
  .superRefine((m, ctx) => {
    const names = m.tiers.map((t) => t.tier);
    if (names.includes('unlock') && m.tiers.length !== 1) ctx.addIssue({ code: 'custom', path: ['tiers'], message: '"unlock" must be the only tier' });
    const order = ['bronze', 'silver', 'gold'];
    const ranked = names.filter((n) => n !== 'unlock');
    if (ranked.some((n, i) => order.indexOf(n) <= order.indexOf(ranked[i - 1] ?? ''))) ctx.addIssue({ code: 'custom', path: ['tiers'], message: 'Tiers must be bronze → silver → gold' });
    for (let i = 1; i < m.tiers.length; i++) {
      if (m.tiers[i]!.gte <= m.tiers[i - 1]!.gte) ctx.addIssue({ code: 'custom', path: ['tiers', i, 'gte'], message: 'Tier thresholds must increase' });
    }
    const agg = m.measure.agg;
    if ((agg === 'days' || agg === 'streak_days') && (m.window === 'session' || m.window === 'day')) {
      ctx.addIssue({ code: 'custom', path: ['window'], message: `"${agg}" needs a week, month or lifetime window` });
    }
  });
export type MilestoneDefinition = z.infer<typeof MilestoneDefinition>;
export type MilestoneDefinitionInput = z.input<typeof MilestoneDefinition>;

/* ------------------------------------------------------------------ */
/* Module definition                                                   */
/* ------------------------------------------------------------------ */

export const ModuleParam = z.object({
  key: z.string().regex(/^[a-z][a-zA-Z0-9]{1,23}$/),
  kind: z.literal('int'),
  min: z.int().min(0).max(100_000),
  max: z.int().min(1).max(100_000),
  default: z.int().min(0).max(100_000),
  unit: ParamUnit,
}).strict();

export const ModuleCounter = z.object({
  id: Ident,
  label: Label(30),
  unit: CounterUnit,
  verification: ClaimVerification,
  maxPerMinute: z.number().min(0.1).max(60),
  maxPerSession: z.int().min(1).max(500),
}).strict();
export type ModuleCounter = z.infer<typeof ModuleCounter>;

export const ModuleTaskType = z.object({
  id: Ident,
  displayName: Label(40),
  completion: TaskCompletion,
  evidence: z.array(z.object({ kind: z.literal('photo'), count: z.int().min(1).max(3), hint: z.string().trim().max(60).default('') }).strict()).max(1).default([]),
  minTaskSeconds: z.int().min(0).max(3600).default(0),
  evidenceRadiusM: z.int().min(10).max(500).default(100),
  weight: z.int().min(1).max(5).default(1),
}).strict();
export type ModuleTaskType = z.infer<typeof ModuleTaskType>;

export const ModuleDefinition = z
  .object({
    schemaVersion: z.literal(MODULE_DSL_VERSION),
    id: z.string().regex(/^[a-z][a-z0-9_]{2,31}$/),
    version: z.int().min(1).max(10_000),
    origin: ModuleOrigin.default('community'),
    forkedFrom: z.object({ id: z.string().regex(/^[a-z][a-z0-9_]{2,31}$/), version: z.int().min(1) }).nullable().default(null),
    meta: z.object({
      displayName: Label(40),
      description: z.string().trim().max(300).default(''),
      icon: ModuleIcon,
      tags: z.array(ModuleTag).max(5).default([]),
      language: z.literal('en').default('en'),
    }).strict(),
    movement: Movement,
    venue: Venue,
    team: z.object({ min: z.int().min(1).max(22), max: z.int().min(1).max(50) }).strict(),
    params: z.array(ModuleParam).max(6).default([]),
    counters: z.array(ModuleCounter).max(6).default([]),
    taskTypes: z.array(ModuleTaskType).max(6).default([]),
    scoring: z.object({
      counterRules: z.array(z.object({ counter: Ident, weight: z.int().min(1).max(5), capPerSession: z.int().min(1).max(50) }).strict()).max(6).default([]),
      dwellWeight: z.int().min(0).max(5).default(0),
      distanceWeight: z.int().min(0).max(5).default(0),
    }).strict().default({ counterRules: [], dwellWeight: 0, distanceWeight: 0 }),
    difficulty: z.array(z.object({ param: z.string(), easy: z.int().min(0), medium: z.int().min(0), hard: z.int().min(0) }).strict()).max(6).default([]),
    plausibility: z.object({ maxSpeedMps: z.number().min(0.5).max(12).optional() }).strict().default({}),
    safety: z.object({
      checklist: z.array(ChecklistItem).max(6).default([]),
      daylightOnly: z.boolean().default(true),
      notes: z.array(SafetyNote).max(8).default([]),
    }).strict().default({ checklist: [], daylightOnly: true, notes: [] }),
    milestones: z.array(MilestoneDefinition).max(12).default([]),
    aiHints: z.object({ description: z.string().trim().max(200).default(''), examples: z.array(z.string().trim().max(80)).max(5).default([]) }).strict().default({ description: '', examples: [] }),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.team.min > d.team.max) ctx.addIssue({ code: 'custom', path: ['team'], message: 'team.min must be ≤ team.max' });
    if (d.origin === 'community' && !d.safety.daylightOnly) ctx.addIssue({ code: 'custom', path: ['safety', 'daylightOnly'], message: 'Community modules are daylight-only' });
    const dup = (ids: string[], path: string) => {
      const seen = new Set<string>();
      ids.forEach((id, i) => {
        if (seen.has(id)) ctx.addIssue({ code: 'custom', path: [path, i, 'id'], message: `Duplicate id "${id}"` });
        seen.add(id);
      });
    };
    dup(d.counters.map((c) => c.id), 'counters');
    dup(d.taskTypes.map((t) => t.id), 'taskTypes');
    dup(d.milestones.map((m) => m.id), 'milestones');
    dup(d.params.map((p) => p.key), 'params');
    d.params.forEach((p, i) => {
      if (p.min > p.max || p.default < p.min || p.default > p.max) ctx.addIssue({ code: 'custom', path: ['params', i], message: 'Param needs min ≤ default ≤ max' });
    });
    d.taskTypes.forEach((t, i) => {
      if (t.completion === 'evidence' && t.evidence.length === 0) ctx.addIssue({ code: 'custom', path: ['taskTypes', i, 'evidence'], message: 'Evidence tasks need a photo requirement' });
      if (t.completion !== 'evidence' && t.evidence.length > 0) ctx.addIssue({ code: 'custom', path: ['taskTypes', i, 'evidence'], message: 'Only evidence tasks take photos' });
    });
    d.difficulty.forEach((r, i) => {
      const p = d.params.find((x) => x.key === r.param);
      if (!p) ctx.addIssue({ code: 'custom', path: ['difficulty', i, 'param'], message: `Unknown param "${r.param}"` });
      else if ([r.easy, r.medium, r.hard].some((v) => v < p.min || v > p.max)) ctx.addIssue({ code: 'custom', path: ['difficulty', i], message: 'Difficulty values must be within the param range' });
    });
  });
export type ModuleDefinition = z.infer<typeof ModuleDefinition>;
export type ModuleDefinitionInput = z.input<typeof ModuleDefinition>;

/** Ids users can never take for custom modules. */
export const RESERVED_MODULE_PREFIXES = ['trina', 'official', 'admin', 'verified', 'test', 'system'] as const;

/** Custom module ids: `u_<slug>_<4 hex>` (fits the challenge DSL ModuleRef id regex). */
export const CUSTOM_MODULE_ID = /^u_[a-z0-9_]{2,24}_[0-9a-f]{4}$/;
