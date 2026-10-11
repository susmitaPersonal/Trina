import { z } from 'zod';
import { Difficulty } from './common';

/**
 * The SMALL structured object an LLM is allowed to produce. A deterministic compiler
 * (`@trina/ai` compileIntent) expands it into a full ChallengeDefinition.
 * The LLM never produces coordinates, scores or rules.
 *
 * Module and task enums are tightened at runtime from the engine registry (see `@trina/ai`).
 */
export const ChallengeIntent = z.object({
  titleHint: z.string().max(80).optional(),
  durationMin: z.int().min(5).max(480),
  participants: z.object({
    count: z.int().min(1).max(500),
    mode: z.enum(['individual', 'team']),
    teams: z.int().min(1).max(50).optional(),
  }),
  activities: z
    .array(z.object({ module: z.string(), intensity: Difficulty.optional() }))
    .min(1)
    .max(3),
  tasks: z
    .array(z.object({ module: z.string(), type: z.string(), quantity: z.int().min(1).max(100).optional() }))
    .max(10)
    .default([]),
  checkpoints: z.object({
    count: z.int().min(0).max(20),
    layout: z.enum(['loop', 'out_and_back', 'scatter']).default('loop'),
    targetDistanceKm: z.number().min(0.2).max(100).optional(),
  }),
  difficulty: Difficulty.default('medium'),
  mindful: z.boolean().default(false),
  unresolved: z.array(z.enum(['start_location', 'date_time', 'team_names'])).default([]),
});
export type ChallengeIntent = z.infer<typeof ChallengeIntent>;
export type ChallengeIntentInput = z.input<typeof ChallengeIntent>;

/** Whitelisted patch operations for "make it harder"-style edits. */
export const IntentPatch = z.object({
  ops: z
    .array(
      z.object({
        op: z.enum(['set', 'add', 'remove']),
        path: z.enum([
          'durationMin',
          'difficulty',
          'participants.count',
          'participants.mode',
          'checkpoints.count',
          'checkpoints.layout',
          'checkpoints.targetDistanceKm',
          'activities',
          'tasks',
          'mindful',
          'titleHint',
        ]),
        value: z.unknown().optional(),
      }),
    )
    .max(10),
});
export type IntentPatch = z.infer<typeof IntentPatch>;
