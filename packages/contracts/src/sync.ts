import { z } from 'zod';
import { Id, IsoDateTime } from './common';
import { MilestoneProgressDto, ProgressDto } from './progress';

export const SYNC_PROTOCOL_VERSION = 1 as const;

/**
 * Events are validated individually on the server (so one bad event never fails the batch),
 * therefore the push request carries them loosely typed.
 */
export const PushRequest = z.object({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  deviceId: Id,
  batchId: Id,
  sessions: z
    .array(
      z.object({
        sessionId: Id,
        events: z.array(z.record(z.string(), z.unknown())).max(500),
      }),
    )
    .min(1)
    .max(20),
});
export type PushRequest = z.infer<typeof PushRequest>;

export const RejectedEvent = z.object({
  eventId: z.string(),
  code: z.string(),
  retryable: z.boolean(),
  detail: z.string().optional(),
});
export type RejectedEvent = z.infer<typeof RejectedEvent>;

export const PushSessionResult = z.object({
  sessionId: Id,
  ackedThroughSeq: z.int().min(0),
  accepted: z.int().min(0),
  duplicates: z.int().min(0),
  rejected: z.array(RejectedEvent),
  missingSeqs: z.array(z.int()),
  evidenceNeeded: z.array(Id),
});
export type PushSessionResult = z.infer<typeof PushSessionResult>;

export const PushResponse = z.object({
  batchId: Id,
  serverTime: IsoDateTime,
  results: z.array(PushSessionResult),
});
export type PushResponse = z.infer<typeof PushResponse>;

export const PullChange = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session_result'),
    id: Id,
    data: z.object({
      sessionId: Id,
      challengeId: Id,
      verdict: z.string(),
      totalPoints: z.int(),
      completed: z.boolean(),
      breakdown: z.array(z.record(z.string(), z.unknown())),
      flags: z.array(z.object({ code: z.string(), severity: z.string(), message: z.string() })),
      wellness: z.record(z.string(), z.unknown()).nullable(),
    }),
  }),
  z.object({
    kind: z.literal('challenge_version'),
    id: Id,
    data: z.object({ challengeId: Id, version: z.int(), status: z.string() }),
  }),
  /** Final milestone windows that changed (server is authoritative; replaces provisional rows). */
  z.object({
    kind: z.literal('milestones'),
    id: Id,
    data: z.object({ items: z.array(MilestoneProgressDto).max(500), revokedKeys: z.array(z.string()).max(500).default([]) }),
  }),
  z.object({ kind: z.literal('progress'), id: Id, data: ProgressDto }),
  /** A module was suspended or taken down: block new sessions with it. */
  z.object({ kind: z.literal('module_status'), id: Id, data: z.object({ moduleId: z.string(), status: z.enum(['active', 'suspended', 'taken_down']) }) }),
]);
export type PullChange = z.infer<typeof PullChange>;

export const PullResponse = z.object({
  changes: z.array(PullChange),
  cursor: z.string(),
  serverTime: IsoDateTime,
});
export type PullResponse = z.infer<typeof PullResponse>;
