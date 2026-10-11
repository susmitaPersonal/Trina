import { ClaimVerification, CounterUnit, MilestoneBasis, ModuleIntent, Movement, SafetyConcern, TaskCompletion, Venue, type ModuleIntent as Intent } from '@trina/contracts';

/**
 * JSON Schema for constrained decoding of a ModuleIntent. Every enum comes from the Module DSL in
 * `@trina/contracts`, so the model literally cannot emit a movement, venue, unit or verification
 * level the engine doesn't know. There is no field for points, thresholds, speeds, ids or coordinates.
 */
export function buildModuleIntentJsonSchema(): Record<string, unknown> {
  const label = { type: 'string', minLength: 2, maxLength: 30 };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['nameHint', 'movement', 'venue', 'team', 'sessionLength', 'counters', 'tasks', 'milestoneIdeas', 'concerns', 'unresolved'],
    properties: {
      nameHint: { type: 'string', minLength: 2, maxLength: 40 },
      movement: { type: 'string', enum: Movement.options },
      venue: { type: 'string', enum: Venue.options },
      team: { type: 'object', additionalProperties: false, required: ['size'], properties: { size: { type: 'string', enum: ['solo', 'pair', 'small_group', 'team', 'two_teams'] } } },
      sessionLength: { type: 'string', enum: ['short', 'medium', 'long'] },
      counters: {
        type: 'array',
        maxItems: 4,
        items: { type: 'object', additionalProperties: false, required: ['label', 'unit', 'verification'], properties: { label, unit: { type: 'string', enum: CounterUnit.options }, verification: { type: 'string', enum: ClaimVerification.options } } },
      },
      tasks: {
        type: 'array',
        maxItems: 4,
        items: { type: 'object', additionalProperties: false, required: ['label', 'completion'], properties: { label, completion: { type: 'string', enum: TaskCompletion.options }, evidenceHint: { type: 'string', maxLength: 60 } } },
      },
      milestoneIdeas: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'basis', 'window'],
          properties: { label, basis: { type: 'string', enum: MilestoneBasis.options }, window: { type: 'string', enum: ['session', 'day', 'week', 'lifetime'] }, counterIndex: { type: 'integer', minimum: 0, maximum: 3 }, taskIndex: { type: 'integer', minimum: 0, maximum: 3 } },
        },
      },
      concerns: { type: 'array', items: { type: 'string', enum: SafetyConcern.options } },
      unresolved: { type: 'array', items: { type: 'string', enum: ['venue', 'team_size', 'activity_unclear'] } },
    },
  };
}

export type ModuleIntentCheck = { ok: true; intent: Intent } | { ok: false; errors: string[] };

/** zod (strict: unknown keys like `points` are errors) + cross-references. */
export function checkModuleIntent(raw: unknown): ModuleIntentCheck {
  const parsed = ModuleIntent.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  const i = parsed.data;
  const errors: string[] = [];
  i.milestoneIdeas.forEach((m, k) => {
    if (m.basis === 'counter' && (m.counterIndex === undefined || m.counterIndex >= i.counters.length)) errors.push(`milestoneIdeas.${k}.counterIndex: must point at one of the ${i.counters.length} counters`);
    if (m.basis === 'task' && (m.taskIndex === undefined || m.taskIndex >= i.tasks.length)) errors.push(`milestoneIdeas.${k}.taskIndex: must point at one of the ${i.tasks.length} tasks`);
  });
  return errors.length ? { ok: false, errors } : { ok: true, intent: i };
}
