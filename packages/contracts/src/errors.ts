import { z } from 'zod';

export const ErrorCode = z.enum([
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'TOKEN_EXPIRED',
  'TOKEN_REUSED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'EMAIL_TAKEN',
  'STALE_VERSION',
  'CHALLENGE_FULL',
  'WINDOW_CLOSED',
  'NOT_PUBLISHED',
  'IDEMPOTENCY_MISMATCH',
  'HASH_CONFLICT',
  'UNSUPPORTED_MEDIA',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'ENGINE_INCOMPATIBLE',
  'COMPILE_FAILED',
  'AI_UNAVAILABLE',
  'MODULE_UNSAFE',
  'MODULE_ID_RESERVED',
  'MODULE_TAKEN_DOWN',
  'MODULE_NAME_TAKEN',
  'PUBLIC_NOT_AVAILABLE',
  'ENGLISH_ONLY',
  'QUOTA_EXCEEDED',
  'GUILD_FULL',
  'INVITE_EXPIRED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** RFC 9457 problem details. */
export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.int(),
  code: ErrorCode,
  detail: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;
