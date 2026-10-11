import type { ChallengeDefinition, Checkpoint, Difficulty, ScoringRule, Task, CompileIssue, ModuleDefinition, ModuleCounter, Verification, MilestoneDefinition, ConfirmationClaim } from '@trina/contracts';
import type { z } from 'zod';

export type FactValue = number | boolean;
export type Facts = Record<string, FactValue>;

export type TaskTypeDef = {
  /** Short id without module prefix, e.g. `collect_items` (full id `cleanup.collect_items`). */
  id: string;
  displayName: string;
  paramsSchema: z.ZodType<Record<string, unknown>>;
  /** `evidence`: needs photo evidence; `self_report`: user taps done; `confirmation`: only a signed confirmation completes it. */
  completion: 'evidence' | 'self_report' | 'confirmation';
  defaultEvidence: { kind: 'photo'; count: number; hint: string }[];
  defaultPoints: number;
  /** Minimum plausible seconds between TaskStarted (or availability) and completion. */
  minTaskSeconds?: number;
  /** Max distance (m) from the task's checkpoint at which evidence counts. */
  evidenceRadiusM?: number;
};

export type ModuleKind = 'activity' | 'task' | 'presence';

export type ModuleDef = {
  id: string;
  version: number;
  displayName: string;
  icon: string;
  kind: ModuleKind;
  paramsSchema: z.ZodType<Record<string, unknown>>;
  taskTypes: TaskTypeDef[];
  plausibility: { maxSpeedMps: number };
  /** MET used for moving segments when this is the primary activity; by speed (m/s) tiers. */
  metBySpeed?: Array<{ upToMps: number; met: number }>;
  /** MET for non-moving active time (e.g. bending to pick litter). */
  restMet?: number;
  /** Extra facts derived from session state. Must be pure. */
  factExtractors?: Array<(state: SessionState, compiled: CompiledChallenge) => Facts>;
  /** Names of facts the extractors can produce (for compile-time validation of conditions). */
  factNames?: string[];
  /** Deterministic scaling of params by difficulty. */
  difficulty?: (params: Record<string, unknown>, level: Difficulty) => Record<string, unknown>;
  /** Hints for the AI prompt/grammar. */
  aiHints: { description: string; examples: string[] };
  /** Rough walking/riding speed used for feasibility warnings (m/s). */
  typicalSpeedMps?: number;
  /** builtin (TS), official (data, in repo) or community (data, runtime). Default builtin. */
  origin?: 'builtin' | 'official' | 'community';
  /** sha256 of the canonical ModuleDefinition (data modules only). */
  definitionHash?: string;
  /** Data view of the module in the Module DSL (all modules; built-ins get a descriptor). */
  descriptor?: ModuleDefinition;
  /** Self-reported counters (data modules). */
  counters?: ModuleCounter[];
  /** Verification level of each fact the module produces (design §2.5). */
  factLevels?: Record<string, Verification>;
};

/** A milestone definition bound to its module version, with its derived verification level. */
export type CompiledMilestone = {
  key: string;
  moduleId: string;
  moduleVersion: number;
  def: MilestoneDefinition;
  verification: Verification;
  /** Facts that only the server can compute (co-presence): unlocks show "Checked after sync" on device. */
  serverOnly: boolean;
};

export type ModuleRegistry = {
  modules: Map<string, ModuleDef>;
  get(id: string): ModuleDef | undefined;
  taskType(fullId: string): { module: ModuleDef; task: TaskTypeDef } | undefined;
  list(): ModuleDef[];
  /** A new registry with extra (runtime) data modules. Reserved/built-in ids can't be shadowed. */
  with(extra: ModuleDef[]): ModuleRegistry;
};

export type CompiledChallenge = {
  definition: ChallengeDefinition;
  modules: ModuleDef[];
  maxSpeedMps: number;
  durationMs: number;
  checkpoints: Map<string, Checkpoint>;
  tasks: Map<string, Task>;
  /** Ordered checkpoint ids for `ordered` routes (else all ids in definition order). */
  routeOrder: string[];
  knownFacts: Set<string>;
  maxScore: number;
  rules: ScoringRule[];
  /** Verification level of every known fact (design §2.5); drives milestone labels. */
  factLevels: Record<string, Verification>;
};

export type CompileResult =
  | { ok: true; compiled: CompiledChallenge; issues: CompileIssue[]; maxScore: number }
  | { ok: false; issues: CompileIssue[] };

export type CheckpointState = {
  reached: boolean;
  reachedAtMono: number | null;
  insideSinceMono: number | null;
  qualifyingFixes: number;
  manual: boolean;
};

export type TaskState = {
  status: 'locked' | 'available' | 'started' | 'done';
  availableAtMono: number | null;
  startedAtMono: number | null;
  completedAtMono: number | null;
  quantity: number | null;
  evidenceIds: string[];
  rejectedCompletions: number;
  /** How the task got done (drives its verification level). */
  doneVia?: 'evidence' | 'self_report' | 'confirmation' | 'legacy_organizer' | null;
};

export type EvidenceRecord = {
  evidenceId: string;
  taskId: string;
  checkpointId: string | null;
  sha256: string;
  monoMs: number;
  fix: { lat: number; lng: number; acc: number } | null;
  /** Reason the evidence was rejected (engine location check or server validation), if any. */
  invalidReason: string | null;
};

export type AcceptedSample = { lng: number; lat: number; acc: number; monoMs: number };

export type SessionState = {
  status: 'not_started' | 'active' | 'paused' | 'completed' | 'abandoned';
  sessionId: string | null;
  startMono: number | null;
  startClientTs: string | null;
  endMono: number | null;
  lastMono: number;
  pausedMs: number;
  pauseStartMono: number | null;
  /** Anchor for distance accumulation (last counted point). */
  anchor: AcceptedSample | null;
  lastSample: AcceptedSample | null;
  distanceM: number;
  movingMs: number;
  samplesTotal: number;
  samplesRejected: { accuracy: number; mocked: number; jump: number };
  checkpoints: Record<string, CheckpointState>;
  tasks: Record<string, TaskState>;
  evidence: Record<string, EvidenceRecord>;
  boundary: { inside: boolean; outsideSinceMono: number | null; exits: number; exitCounted: boolean };
  inEndZone: boolean;
  steps: number | null;
  backgroundSinceMono: number | null;
  backgroundMs: number;
  gpsLost: number;
  lateEvents: number;
  completionReason: string | null;
  /** Track points kept for route display (accepted samples only). */
  track: AcceptedSample[];
  /* ---- engine v2 (milestones, data modules, offline quests) ---- */
  /** Time with accepted fixes inside the play area (boundary, or start zone when no boundary). */
  zoneDwellMs: number;
  lastZoneMono: number | null;
  /** Merged [startMono, endMono] intervals inside the zone (≤ 50), for server co-presence. */
  zoneIntervals: Array<[number, number]>;
  /** Self-reported counter totals by `<module>.<counter>`. */
  counters: Record<string, number>;
  /** Confirmed counter totals by `<module>.<counter>` (provisional on device, matched-only on server). */
  confirmed: Record<string, number>;
  /** Confirmation ids already applied (idempotent). */
  confirmationIds: string[];
  /** Local UTC offset recorded at start (minutes); null for old apps. */
  tzOffsetMin: number | null;
  quest: { templateId: string; targetMinutes: number; levelTier: 'easy' | 'medium' | 'hard' } | null;
  /** Connectivity: null = never reported. */
  online: boolean | null;
  offlineSinceMono: number | null;
  offlineIntervals: Array<[number, number]>;
  questStop: 'force' | 'safety' | null;
};

export type BreakdownItem = {
  ruleId: string;
  label: string;
  points: number;
  status: 'awarded' | 'not_met' | 'invalidated' | 'penalty';
  reason?: string;
};

export type ScoreResult = {
  total: number;
  maxScore: number;
  completed: boolean;
  breakdown: BreakdownItem[];
  facts: Facts;
  engineVersion: number;
};

export type EvaluateOptions = {
  /** evidenceId → reason, supplied by server validation (hash mismatch, missing upload, duplicate…). */
  invalidEvidence?: Record<string, string>;
  /**
   * Confirmations. `provisional` (device): every ConfirmationReceived whose signature was checked at scan
   * time counts. `final` (server): only `matched` ones count, with the server-approved claims.
   */
  confirmations?: { mode: 'provisional' } | { mode: 'final'; matched: Record<string, ConfirmationClaim[]> };
  /** Server only: mono intervals where the device talked to the server (removed from offline time). */
  onlineMono?: Array<[number, number]>;
};

export type WellnessResult = {
  steps: number | null;
  avgCadenceSpm: number | null;
  activeMinutes: number;
  phoneFreeMinutes: number;
  kcalEstimate: number | null;
  kcalApprox: boolean;
  moodBefore: number | null;
  moodAfter: number | null;
};
