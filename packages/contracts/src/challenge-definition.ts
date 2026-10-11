import { z } from 'zod';
import { CircleZone, Difficulty, IsoDateTime, PolygonZone, Sha256Hex, Visibility, Zone } from './common';

/** 1.1 (additive, ADR-029): ModuleRef.definitionHash, `per_count` rule, `zone_dwell_s` metric. 1.0 still accepted. */
export const DSL_SCHEMA_VERSION = '1.1' as const;
export const DSL_SCHEMA_VERSIONS = ['1.0', '1.1'] as const;

/* ------------------------------------------------------------------ */
/* Condition AST: closed, data-only. Never evaluated as code.          */
/* ------------------------------------------------------------------ */

export const ComparisonOp = z.enum(['==', '!=', '<', '<=', '>', '>=']);
export type ComparisonOp = z.infer<typeof ComparisonOp>;

export type FactCondition = { fact: string; op: ComparisonOp; value: number | boolean | 'ALL' };
export type Condition = FactCondition | { all: Condition[] } | { any: Condition[] } | { not: Condition };

export const FactConditionSchema = z.object({
  fact: z.string().min(1).max(64),
  op: ComparisonOp,
  value: z.union([z.number(), z.boolean(), z.literal('ALL')]),
});

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    FactConditionSchema,
    z.object({ all: z.array(ConditionSchema).min(1).max(20) }),
    z.object({ any: z.array(ConditionSchema).min(1).max(20) }),
    z.object({ not: ConditionSchema }),
  ]),
);

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

const RuleId = z.string().regex(/^[a-z0-9_-]{1,32}$/i);

export const PerCheckpointRule = z.object({
  id: RuleId,
  kind: z.literal('per_checkpoint'),
  points: z.int().min(0).max(1000),
  checkpointIds: z.array(z.string()).optional(),
});
export const PerTaskRule = z.object({
  id: RuleId,
  kind: z.literal('per_task'),
  task: z.string(),
  points: z.int().min(0).max(1000),
});
export const MetricRateRule = z.object({
  id: RuleId,
  kind: z.literal('metric_rate'),
  metric: z.enum(['distance_m', 'active_minutes', 'duration_s', 'zone_dwell_s']),
  pointsPer: z.int().min(1).max(100),
  per: z.number().positive(),
  cap: z.int().min(0).max(5000),
});
/** Points per counted unit of a count fact (e.g. confirmed catches), capped. Self-reported facts are refused by compile. */
export const PerCountRule = z.object({
  id: RuleId,
  kind: z.literal('per_count'),
  fact: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*(\.[a-z_]+)?$/),
  label: z.string().max(80).optional(),
  pointsPer: z.int().min(1).max(100),
  per: z.int().min(1).max(50).default(1),
  cap: z.int().min(0).max(2000),
});
export const ScoringRule = z.discriminatedUnion('kind', [PerCheckpointRule, PerTaskRule, MetricRateRule, PerCountRule]);
export type ScoringRule = z.infer<typeof ScoringRule>;

export const BonusRule = z.object({
  id: RuleId,
  kind: z.literal('condition'),
  label: z.string().max(80).optional(),
  when: ConditionSchema,
  points: z.int().min(0).max(1000),
});
export type BonusRule = z.infer<typeof BonusRule>;

export const PenaltyRule = z.object({
  id: RuleId,
  kind: z.literal('per_occurrence'),
  label: z.string().max(80).optional(),
  fact: z.string(),
  points: z.int().min(-1000).max(0),
  graceCount: z.int().min(0).max(100).default(0),
});
export type PenaltyRule = z.infer<typeof PenaltyRule>;

/* ------------------------------------------------------------------ */
/* Structure                                                           */
/* ------------------------------------------------------------------ */

export const ModuleRef = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
  version: z.int().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  /** Pins a data module version's exact content (custom/official data modules). */
  definitionHash: Sha256Hex.optional(),
});
export type ModuleRef = z.infer<typeof ModuleRef>;

export const Checkpoint = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,32}$/i),
  name: z.string().min(1).max(80),
  geometry: CircleZone,
  required: z.boolean().default(true),
  dwellSec: z.int().min(0).max(600).default(5),
  maxAccuracyM: z.number().min(5).max(200).default(40),
});
export type Checkpoint = z.infer<typeof Checkpoint>;

export const EvidenceRequirement = z.object({
  kind: z.literal('photo'),
  count: z.int().min(1).max(5).default(1),
  hint: z.string().max(120).default(''),
});
export type EvidenceRequirement = z.infer<typeof EvidenceRequirement>;

export const TaskLocation = z.object({
  kind: z.enum(['anywhere', 'checkpoint', 'in_boundary']),
  ref: z.string().optional(),
});

export const Task = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,32}$/i),
  /** `<moduleId>.<taskType>`, e.g. `cleanup.collect_items` */
  type: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
  title: z.string().max(80).optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  location: TaskLocation.default({ kind: 'anywhere' }),
  evidence: z.array(EvidenceRequirement).max(3).default([]),
  required: z.boolean().default(true),
  scope: z.enum(['individual', 'team']).default('individual'),
});
export type Task = z.infer<typeof Task>;

export const ChallengeDefinition = z.object({
  schemaVersion: z.enum(DSL_SCHEMA_VERSIONS),
  meta: z.object({
    title: z.string().min(3).max(80),
    description: z.string().max(2000).default(''),
    tags: z.array(z.string().max(24)).max(10).default([]),
    difficulty: Difficulty.default('medium'),
    visibility: Visibility.default('public'),
    language: z.string().min(2).max(8).default('en'),
  }),
  modules: z.array(ModuleRef).min(1).max(6),
  mode: z.enum(['individual', 'team']).default('individual'),
  participants: z.object({
    min: z.int().min(1).default(1),
    max: z.int().min(1).max(500).default(50),
    teams: z.object({ count: z.int().min(1).max(50), sizeMax: z.int().min(1).max(50) }).optional(),
  }),
  timing: z.object({
    durationMin: z.int().min(5).max(480),
    window: z.object({ opensAt: IsoDateTime, closesAt: IsoDateTime }).optional(),
    startGraceMin: z.int().min(0).max(120).default(10),
    daylightOnly: z.boolean().default(false),
  }),
  area: z.object({
    startZone: CircleZone,
    boundary: z
      .discriminatedUnion('type', [
        CircleZone.extend({ graceM: z.number().min(0).max(500).default(50) }),
        PolygonZone.extend({ graceM: z.number().min(0).max(500).default(50) }),
      ])
      .optional(),
    endZone: CircleZone.optional(),
  }),
  route: z.object({
    type: z.enum(['ordered', 'unordered', 'free']).default('unordered'),
    checkpointIds: z.array(z.string()).default([]),
  }),
  checkpoints: z.array(Checkpoint).max(50).default([]),
  tasks: z.array(Task).max(50).default([]),
  scoring: z.object({
    rules: z.array(ScoringRule).max(50).default([]),
    bonuses: z.array(BonusRule).max(20).default([]),
    penalties: z.array(PenaltyRule).max(20).default([]),
    teamAggregation: z.enum(['sum', 'avg', 'min']).default('sum'),
  }),
  completion: z.object({
    all: z.array(ConditionSchema).max(20).optional(),
    any: z.array(ConditionSchema).max(20).optional(),
    endZoneRequired: z.boolean().default(false),
  }),
  safety: z
    .object({
      maxSpeedMps: z.number().min(1).max(40).optional(),
      noSpeedRewards: z.literal(true).default(true),
    })
    .default({ noSpeedRewards: true }),
});

export type ChallengeDefinition = z.infer<typeof ChallengeDefinition>;
/** Input type (before defaults are applied), useful for authoring fixtures. */
export type ChallengeDefinitionInput = z.input<typeof ChallengeDefinition>;

export { Zone };
