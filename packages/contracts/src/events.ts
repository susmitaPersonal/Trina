import { z } from 'zod';
import { Fix, Id, IsoDateTime, Sha256Hex } from './common';
import { ConfirmationClaims, ConfirmationRole, PublicKeyHex, SignatureHex } from './confirmation';
import { PartyInvite, SightingToken } from './party';

export const EVENT_SCHEMA_VERSION = 1 as const;

export const LocationSample = z.object({
  ts: IsoDateTime,
  monoMs: z.int().min(0),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  acc: z.number().min(0).max(10_000),
  speed: z.number().nullable().default(null),
  heading: z.number().nullable().default(null),
  alt: z.number().nullable().default(null),
  mocked: z.boolean().default(false),
});
export type LocationSample = z.infer<typeof LocationSample>;

export const MoodValue = z.int().min(1).max(5);

export const WellnessShare = z.object({
  moodBefore: MoodValue.nullable().optional(),
  moodAfter: MoodValue.nullable().optional(),
});

const payloads = {
  SessionStarted: z.object({
    challengeId: Id,
    challengeVersion: z.int().min(1),
    definitionHash: Sha256Hex,
    deviceId: Id,
    userId: Id,
    teamId: Id.nullable(),
    bootId: z.string().max(64),
    clockOffsetMsAtDownload: z.int(),
    startFix: Fix,
    /** Local UTC offset at start (minutes east of UTC). Drives the day key (ADR-025). Optional for old apps. */
    tzOffsetMin: z.int().min(-720).max(840).optional(),
    /** Set for offline Daily Quests: the server rebuilds the definition from this template (design §5A.2). */
    quest: z
      .object({ templateId: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/), targetMinutes: z.union([z.literal(30), z.literal(45), z.literal(60), z.literal(90)]), levelTier: z.enum(['easy', 'medium', 'hard']) })
      .nullable()
      .optional(),
    /** Set for Offline Party sessions: the signed invite, so the server can verify it and rebuild the definition (ADR-033). */
    party: z.object({ invite: PartyInvite, role: z.enum(['host', 'member']) }).nullable().optional(),
  }),
  LocationBatch: z.object({ samples: z.array(LocationSample).min(1).max(200) }),
  GpsSignalLost: z.object({}),
  GpsSignalRestored: z.object({}),
  CheckpointEntered: z.object({ checkpointId: z.string(), fix: Fix }),
  CheckpointManualConfirm: z.object({ checkpointId: z.string(), fix: Fix.nullable() }),
  TaskStarted: z.object({ taskId: z.string() }),
  EvidenceCaptured: z.object({
    evidenceId: Id,
    taskId: z.string(),
    checkpointId: z.string().nullable(),
    sha256: Sha256Hex,
    bytes: z.int().min(1).max(20_000_000),
    mime: z.enum(['image/jpeg', 'image/webp']).default('image/jpeg'),
    fix: Fix.nullable(),
  }),
  TaskCompleted: z.object({ taskId: z.string(), quantity: z.int().min(0).max(10_000).optional() }),
  TaskUndone: z.object({ taskId: z.string() }),
  BoundaryExited: z.object({ fix: Fix }),
  BoundaryEntered: z.object({ fix: Fix }),
  SessionPaused: z.object({}),
  SessionResumed: z.object({}),
  AppBackgrounded: z.object({}),
  AppForegrounded: z.object({}),
  MockLocationDetected: z.object({ fix: Fix }),
  ClockAnomalyDetected: z.object({ kind: z.string().max(40), detail: z.string().max(200) }),
  StepsSample: z.object({
    cumulative: z.int().min(0),
    delta: z.int().min(0).max(100_000),
    source: z.enum(['android_step_counter', 'ios_pedometer', 'expo_pedometer', 'simulated']),
  }),
  SessionCompleted: z.object({
    reason: z.enum(['rules', 'manual', 'timeout']),
    provisionalScore: z.int(),
    wellness: WellnessShare.optional(),
    signature: z.string().max(512).optional(),
  }),
  SessionAbandoned: z.object({ reason: z.string().max(200) }),
  /** @deprecated ADR-026: self-written, so engine v2 treats it as self-report. Kept so old logs still parse. */
  OrganizerConfirmation: z.object({ taskId: z.string(), confirmedBy: Id }),
  /** Self-reported counter tap. Negative deltas are corrections (events stay append-only). */
  CountReported: z.object({
    counterId: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
    delta: z.int().min(-20).max(20).refine((d) => d !== 0, 'delta must not be 0'),
  }),
  /** Written by the CONFIRMER, in the confirmer's own session (signed with the device key). */
  ConfirmationIssued: z.object({
    confirmationId: Id,
    challengeId: Id,
    subjectUserId: Id,
    subjectSessionId: Id,
    role: ConfirmationRole,
    claims: ConfirmationClaims,
    sig: SignatureHex,
  }),
  /** Written by the SUBJECT after scanning the confirmer's QR. Provisional until the server matches it. */
  ConfirmationReceived: z.object({
    confirmationId: Id,
    issuerUserId: Id,
    issuerDeviceId: Id,
    issuerPublicKey: PublicKeyHex,
    role: ConfirmationRole,
    claims: ConfirmationClaims,
    sig: SignatureHex,
  }),
  /** Offline Quest Mode: connectivity on/off. Only the state is stored (no network names or addresses). */
  ConnectivityChanged: z.object({ online: z.boolean(), transport: z.enum(['wifi', 'cellular', 'other', 'none']) }),
  /** Why a quest was stopped. `safety` stops never count toward the weekly penalty. */
  QuestStopped: z.object({
    kind: z.enum(['force', 'safety']),
    reason: z.enum(['unwell', 'weather', 'emergency', 'need_phone', 'other']).nullable(),
  }),
  /**
   * Two phones in one party met (QR handshake, ADR-034). `peer` is the other side's signed token, so this
   * chain now records the peer's chain head; `myNonce` is the nonce this phone showed. No coordinates.
   */
  PeerSighting: z.object({
    sightingId: Id,
    kind: z.enum(['join', 'checkpoint', 'wrapup']),
    peer: SightingToken,
    myNonce: z.string().regex(/^[0-9a-f]{16}$/),
  }),
} as const;

export type EventType = keyof typeof payloads;
export const EVENT_TYPES = Object.keys(payloads) as EventType[];
export const EventPayloadSchemas = payloads;

const envelope = {
  eventId: Id,
  sessionId: Id,
  seq: z.int().min(1),
  schemaVersion: z.int().min(1),
  clientTs: IsoDateTime,
  monoMs: z.int().min(0),
  prevHash: Sha256Hex,
  hash: Sha256Hex,
};

function eventVariant<T extends EventType>(type: T) {
  return z.object({ ...envelope, type: z.literal(type), payload: payloads[type] });
}

export const ActivityEvent = z.discriminatedUnion('type', [
  eventVariant('SessionStarted'),
  eventVariant('LocationBatch'),
  eventVariant('GpsSignalLost'),
  eventVariant('GpsSignalRestored'),
  eventVariant('CheckpointEntered'),
  eventVariant('CheckpointManualConfirm'),
  eventVariant('TaskStarted'),
  eventVariant('EvidenceCaptured'),
  eventVariant('TaskCompleted'),
  eventVariant('TaskUndone'),
  eventVariant('BoundaryExited'),
  eventVariant('BoundaryEntered'),
  eventVariant('SessionPaused'),
  eventVariant('SessionResumed'),
  eventVariant('AppBackgrounded'),
  eventVariant('AppForegrounded'),
  eventVariant('MockLocationDetected'),
  eventVariant('ClockAnomalyDetected'),
  eventVariant('StepsSample'),
  eventVariant('SessionCompleted'),
  eventVariant('SessionAbandoned'),
  eventVariant('OrganizerConfirmation'),
  eventVariant('CountReported'),
  eventVariant('ConfirmationIssued'),
  eventVariant('ConfirmationReceived'),
  eventVariant('ConnectivityChanged'),
  eventVariant('QuestStopped'),
  eventVariant('PeerSighting'),
]);
export type ActivityEvent = z.infer<typeof ActivityEvent>;
export type EventOf<T extends EventType> = Extract<ActivityEvent, { type: T }>;
export type PayloadOf<T extends EventType> = z.infer<(typeof payloads)[T]>;
/** An event before it has been sequenced and hashed by the EventWriter. */
export type UnsealedEvent<T extends EventType = EventType> = {
  type: T;
  payload: PayloadOf<T>;
  clientTs: string;
  monoMs: number;
};
