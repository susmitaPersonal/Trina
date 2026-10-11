import { z } from 'zod';
import { ClaimVerification, CounterUnit, Movement, TaskCompletion, Venue } from './module-definition';

/**
 * The ONLY structure the LLM may emit for a custom module (ADR-027). Enums, short labels and
 * safety concerns. NO points, weights, thresholds, speeds, coordinates, ids, fact names, URLs,
 * or `sensor` verification. A deterministic compiler (`@trina/ai` compileModuleIntent) turns it
 * into a ModuleDefinition using fixed tables.
 */
export const SafetyConcern = z.enum([
  'height', 'water', 'fire', 'traffic', 'animals', 'sharp_string', 'heat', 'night', 'alcohol', 'weapons', 'private_property', 'motor_vehicle',
]);
export type SafetyConcern = z.infer<typeof SafetyConcern>;

export const MilestoneBasis = z.enum(['dwell', 'distance', 'steps', 'counter', 'task', 'copresence', 'time_of_day_morning', 'streak']);
export type MilestoneBasis = z.infer<typeof MilestoneBasis>;

const ShortLabel = z.string().trim().min(2).max(30);

export const ModuleIntent = z
  .object({
    nameHint: z.string().trim().min(2).max(40),
    movement: Movement,
    venue: Venue,
    team: z.object({ size: z.enum(['solo', 'pair', 'small_group', 'team', 'two_teams']) }).strict(),
    sessionLength: z.enum(['short', 'medium', 'long']).default('medium'),
    counters: z.array(z.object({ label: ShortLabel, unit: CounterUnit, verification: ClaimVerification }).strict()).max(4).default([]),
    tasks: z
      .array(z.object({ label: ShortLabel, completion: TaskCompletion, evidenceHint: z.string().trim().max(60).optional() }).strict())
      .max(4)
      .default([]),
    milestoneIdeas: z
      .array(
        z
          .object({
            label: ShortLabel,
            basis: MilestoneBasis,
            window: z.enum(['session', 'day', 'week', 'lifetime']),
            counterIndex: z.int().min(0).max(3).optional(),
            taskIndex: z.int().min(0).max(3).optional(),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    concerns: z.array(SafetyConcern).max(12).default([]),
    unresolved: z.array(z.enum(['venue', 'team_size', 'activity_unclear'])).max(3).default([]),
  })
  .strict();
export type ModuleIntent = z.infer<typeof ModuleIntent>;
export type ModuleIntentInput = z.input<typeof ModuleIntent>;
