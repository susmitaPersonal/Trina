import { z } from 'zod';
import { ChallengeDefinition } from './challenge-definition';
import { ChallengeIntent, IntentPatch } from './challenge-intent';
import { Difficulty, Id, IsoDateTime, LngLat, Sha256Hex, Visibility } from './common';

/* ---------------------------------- Auth ---------------------------------- */

export const DeviceInfo = z.object({
  id: Id,
  platform: z.enum(['android', 'ios', 'web', 'test']),
  appVersion: z.string().max(32),
  osVersion: z.string().max(32).optional(),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

export const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const Password = z.string().min(10).max(128);

export const RegisterRequest = z.object({
  email: Email,
  password: Password,
  displayName: z.string().trim().min(2).max(40),
  ageConfirmed: z.literal(true),
  device: DeviceInfo,
});
export type RegisterRequest = z.input<typeof RegisterRequest>;

export const LoginRequest = z.object({ email: Email, password: z.string().min(1).max(128), device: DeviceInfo });
export type LoginRequest = z.input<typeof LoginRequest>;

export const RefreshRequest = z.object({ refreshToken: z.string().min(20).max(200), deviceId: Id });
export type RefreshRequest = z.infer<typeof RefreshRequest>;

export const LogoutRequest = z.object({ refreshToken: z.string().min(20).max(200) });

export const UserDto = z.object({
  id: Id,
  email: z.string(),
  displayName: z.string(),
  role: z.enum(['user', 'admin']),
  shareWellbeing: z.boolean(),
  createdAt: IsoDateTime,
});
export type UserDto = z.infer<typeof UserDto>;

export const AuthResponse = z.object({
  user: UserDto,
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.int(),
});
export type AuthResponse = z.infer<typeof AuthResponse>;

export const PatchMeRequest = z.object({
  displayName: z.string().trim().min(2).max(40).optional(),
  shareWellbeing: z.boolean().optional(),
});

/* ------------------------------- Challenges ------------------------------- */

export const ChallengeStatus = z.enum(['draft', 'published', 'cancelled', 'archived']);

export const ChallengeSummary = z.object({
  id: Id,
  title: z.string(),
  status: ChallengeStatus,
  visibility: Visibility,
  difficulty: Difficulty,
  moduleIds: z.array(z.string()),
  durationMin: z.int(),
  startPoint: LngLat,
  distanceKm: z.number().nullable(),
  opensAt: IsoDateTime.nullable(),
  closesAt: IsoDateTime.nullable(),
  participants: z.int(),
  maxParticipants: z.int(),
  creatorName: z.string(),
  currentVersion: z.int(),
});
export type ChallengeSummary = z.infer<typeof ChallengeSummary>;

export const ListChallengesQuery = z.object({
  near: z
    .string()
    .regex(/^-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?$/)
    .optional(),
  radiusKm: z.coerce.number().min(1).max(50).default(25),
  module: z.string().optional(),
  difficulty: Difficulty.optional(),
  maxDuration: z.coerce.number().int().min(5).max(480).optional(),
  mine: z.enum(['created', 'joined']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const CompileIssue = z.object({ path: z.string(), message: z.string(), severity: z.enum(['error', 'warning']) });
export type CompileIssue = z.infer<typeof CompileIssue>;

export const CreateChallengeRequest = z.object({
  definition: z.unknown(),
  aiGenerationId: Id.optional(),
});
export const PatchChallengeRequest = z.object({ definition: z.unknown(), baseVersion: z.int().min(1) });
export const PublishRequest = z.object({ version: z.int().min(1) });

export const ChallengeDetail = z.object({
  challenge: ChallengeSummary,
  definition: ChallengeDefinition,
  definitionHash: Sha256Hex,
  maxScore: z.int(),
  myParticipation: z
    .object({ status: z.string(), teamId: Id.nullable(), joinedVersion: z.int() })
    .nullable(),
  teams: z.array(z.object({ id: Id, name: z.string(), members: z.int() })),
  isCreator: z.boolean(),
});
export type ChallengeDetail = z.infer<typeof ChallengeDetail>;

export const JoinRequest = z.object({
  teamId: Id.optional(),
  newTeamName: z.string().trim().min(2).max(40).optional(),
});

export const BundleDto = z.object({
  challengeId: Id,
  version: z.int(),
  definition: ChallengeDefinition,
  definitionHash: Sha256Hex,
  engineMinVersion: z.int(),
  maxScore: z.int(),
  mapPack: z.object({ url: z.string(), bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]) }).nullable(),
  ruleText: z.array(z.string()),
  encouragement: z.array(z.object({ trigger: z.string(), text: z.string() })),
  participation: z.object({ teamId: Id.nullable(), joinedVersion: z.int() }),
  serverTime: IsoDateTime,
  /** Non-built-in data modules this version pins (custom modules), so play works offline (design §7.2). */
  modules: z.array(z.object({ id: z.string(), version: z.int(), definition: z.unknown(), definitionHash: Sha256Hex })).default([]),
  /** Participants' device public keys, for offline confirmation checks (ADR-026). */
  participantKeys: z.array(z.object({ userId: Id, deviceId: Id, publicKey: z.string(), displayName: z.string() })).default([]),
});
export type BundleDto = z.infer<typeof BundleDto>;

export const LeaderboardDto = z.object({
  challengeId: Id,
  scope: z.enum(['individual', 'team']),
  entries: z.array(
    z.object({
      rank: z.int(),
      subjectId: Id,
      name: z.string(),
      points: z.int(),
      timeS: z.int().nullable(),
      verification: z.enum(['verified', 'verified_with_notes']),
    }),
  ),
  pending: z.int(),
  updatedAt: IsoDateTime,
});
export type LeaderboardDto = z.infer<typeof LeaderboardDto>;

/* -------------------------------- Sessions -------------------------------- */

export const WellnessDto = z.object({
  steps: z.int().nullable(),
  avgCadenceSpm: z.int().nullable(),
  activeMinutes: z.int(),
  phoneFreeMinutes: z.int(),
  kcalEstimate: z.int().nullable(),
  kcalApprox: z.boolean(),
  moodBefore: z.int().nullable().optional(),
  moodAfter: z.int().nullable().optional(),
});
export type WellnessDto = z.infer<typeof WellnessDto>;

export const SessionDto = z.object({
  id: Id,
  challengeId: Id,
  challengeTitle: z.string(),
  challengeVersion: z.int(),
  status: z.string(),
  verdict: z.string().nullable(),
  startedAt: IsoDateTime.nullable(),
  endedAt: IsoDateTime.nullable(),
  score: z
    .object({
      totalPoints: z.int(),
      completed: z.boolean(),
      durationS: z.int(),
      distanceM: z.int(),
      breakdown: z.array(z.record(z.string(), z.unknown())),
      status: z.string(),
    })
    .nullable(),
  flags: z.array(z.object({ code: z.string(), severity: z.string(), message: z.string() })),
  wellness: WellnessDto.nullable(),
});
export type SessionDto = z.infer<typeof SessionDto>;

/* ----------------------------------- AI ----------------------------------- */

export const AiDraftRequest = z.object({
  prompt: z.string().trim().min(3).max(1000),
  mode: z.enum(['create', 'variations', 'patch']).default('create'),
  baseIntent: ChallengeIntent.optional(),
  context: z
    .object({
      startPoint: LngLat.optional(),
      preferredModules: z.array(z.string()).max(5).optional(),
      language: z.string().max(8).optional(),
    })
    .default({}),
});
export type AiDraftRequest = z.input<typeof AiDraftRequest>;

export const AiDraftResponse = z.object({
  generationId: Id,
  intents: z.array(ChallengeIntent),
  definitions: z.array(z.unknown()),
  issues: z.array(CompileIssue),
  notes: z.array(z.string()),
  provider: z.object({ id: z.string(), modelId: z.string(), locality: z.enum(['device', 'self_hosted', 'none']) }),
});
export type AiDraftResponse = z.infer<typeof AiDraftResponse>;

export const AiRecapRequest = z.object({ sessionId: Id });
export const AiRecapResponse = z.object({ text: z.string(), provider: z.string() });

export const ModelManifestEntry = z.object({
  id: z.string(),
  family: z.string(),
  quant: z.string(),
  bytes: z.int(),
  sha256: z.string(),
  url: z.string(),
  minRamGb: z.number(),
  license: z.string(),
});
export type ModelManifestEntry = z.infer<typeof ModelManifestEntry>;

export { IntentPatch };

/* ------------------------------ Data modules ------------------------------ */

export const ModuleVisibility = z.enum(['private', 'unlisted', 'public']);
export const ModuleStatus = z.enum(['draft', 'active', 'suspended', 'taken_down']);

export const ModuleSummaryDto = z.object({
  id: z.string(),
  version: z.int(),
  origin: z.enum(['builtin', 'official', 'community']),
  displayName: z.string(),
  icon: z.string(),
  movement: z.string().nullable(),
  venue: z.string().nullable(),
  status: ModuleStatus,
  visibility: ModuleVisibility,
  ownerName: z.string().nullable(),
  mine: z.boolean(),
  taskTypes: z.array(z.object({ id: z.string(), displayName: z.string(), completion: z.string() })),
});
export type ModuleSummaryDto = z.infer<typeof ModuleSummaryDto>;

export const SafetyReportDto = z.object({
  level: z.enum(['ok', 'note', 'private_only', 'blocked']),
  findings: z.array(z.object({ category: z.string(), term: z.string(), outcome: z.string(), message: z.string() })),
  notes: z.array(z.string()),
  concerns: z.array(z.string()),
});
export type SafetyReportDto = z.infer<typeof SafetyReportDto>;

export const ModuleVersionDto = z.object({
  id: z.string(),
  version: z.int(),
  status: ModuleStatus,
  visibility: ModuleVisibility,
  definition: z.unknown(),
  definitionHash: Sha256Hex,
  risk: SafetyReportDto,
  owner: z.object({ displayName: z.string() }).nullable(),
  forkedFrom: z.object({ id: z.string(), version: z.int() }).nullable(),
  publishedAt: IsoDateTime.nullable(),
  mine: z.boolean(),
});
export type ModuleVersionDto = z.infer<typeof ModuleVersionDto>;

export const CreateModuleRequest = z.object({ definition: z.unknown(), aiGenerationId: Id.optional() });
export const PatchModuleRequest = z.object({ definition: z.unknown(), baseVersion: z.int().min(1) });
/** MVP: private or unlisted only (ADR-028). `public` is answered with 403 PUBLIC_NOT_AVAILABLE. */
export const PublishModuleRequest = z.object({ version: z.int().min(1), visibility: ModuleVisibility.default('private') });
export const ForkModuleRequest = z.object({ fromVersion: z.int().min(1) });
export const ReportModuleRequest = z.object({ reason: z.enum(['unsafe', 'offensive', 'impersonation', 'spam', 'other']), note: z.string().trim().max(300).optional() });

export const ModuleDraftRequest = z.object({ prompt: z.string().trim().min(3).max(500) });
export const ModuleDraftResponse = z.object({
  generationId: Id,
  status: z.enum(['ok', 'refused', 'english_only']),
  refusal: z.string().nullable(),
  intent: z.unknown().nullable(),
  definition: z.unknown().nullable(),
  issues: z.array(CompileIssue),
  risk: SafetyReportDto,
  notes: z.array(z.string()),
  usedFallback: z.boolean(),
  provider: z.object({ id: z.string(), modelId: z.string(), locality: z.enum(['device', 'self_hosted', 'none']) }),
});
export type ModuleDraftResponse = z.infer<typeof ModuleDraftResponse>;

export const ModerationDecisionRequest = z.object({ decision: z.enum(['dismiss', 'suspend', 'take_down', 'restore']), note: z.string().trim().max(500).default('') });

export const RegisterDeviceKeyRequest = z.object({ publicKey: z.string().regex(/^[0-9a-f]{64}$/) });

export const MilestoneCatalogItemDto = z.object({
  key: z.string(),
  moduleId: z.string(),
  milestoneId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  window: z.string(),
  tiers: z.array(z.object({ tier: z.string(), gte: z.number() })),
  verification: z.string(),
  stat: z.string(),
  hidden: z.boolean(),
});
export type MilestoneCatalogItemDto = z.infer<typeof MilestoneCatalogItemDto>;

/* --------------------------------- Guilds -------------------------------- */

export const CreateGuildRequest = z.object({ name: z.string().trim().min(3).max(40), description: z.string().trim().max(200).default(''), icon: z.string().max(20).default('leaf') });
export const JoinGuildRequest = z.object({ code: z.string().regex(/^[A-Z0-9]{8}$/) });
export const CreateInviteRequest = z.object({ maxUses: z.int().min(1).max(50).default(10) });
export const GuildDto = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  memberLimit: z.int(),
  members: z.array(z.object({ userId: Id, displayName: z.string(), role: z.enum(['leader', 'officer', 'member']), rank: z.string() })),
  myRole: z.enum(['leader', 'officer', 'member']).nullable(),
});
export type GuildDto = z.infer<typeof GuildDto>;
export const GuildBoardDto = z.object({
  guildId: Id,
  period: z.enum(['week', 'season']),
  weekKey: z.string(),
  entries: z.array(z.object({ userId: Id, displayName: z.string(), xp: z.int(), offlineMinutes: z.int() })),
  guildQuest: z.object({ title: z.string(), target: z.int(), value: z.int() }),
});
export type GuildBoardDto = z.infer<typeof GuildBoardDto>;

