import { ChallengeIntent, type ChallengeIntent as Intent } from '@trina/contracts';
import { defaultRegistry, type ModuleRegistry } from '@trina/engine';

/**
 * JSON Schema for constrained decoding. Module and task enums come from the engine registry,
 * so the model literally cannot emit a module the engine doesn't know.
 */
export function buildIntentJsonSchema(registry: ModuleRegistry = defaultRegistry): Record<string, unknown> {
  const modules = registry.list().filter(isChallengeAgentModule);
  const activityIds = modules.filter((m) => m.kind === 'activity').map((m) => m.id);
  const taskModuleIds = modules.filter((m) => m.taskTypes.length > 0).map((m) => m.id);
  const taskTypeIds = [...new Set(modules.flatMap((m) => m.taskTypes.map((t) => t.id)))];
  return {
    type: 'object',
    additionalProperties: false,
    required: ['durationMin', 'participants', 'activities', 'tasks', 'checkpoints', 'difficulty', 'mindful', 'unresolved'],
    properties: {
      titleHint: { type: 'string', maxLength: 60 },
      durationMin: { type: 'integer', minimum: 5, maximum: 480 },
      participants: {
        type: 'object',
        additionalProperties: false,
        required: ['count', 'mode'],
        properties: {
          count: { type: 'integer', minimum: 1, maximum: 500 },
          mode: { type: 'string', enum: ['individual', 'team'] },
          teams: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
      activities: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['module'],
          properties: { module: { type: 'string', enum: activityIds }, intensity: { type: 'string', enum: ['easy', 'medium', 'hard'] } },
        },
      },
      tasks: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['module', 'type'],
          properties: {
            module: { type: 'string', enum: taskModuleIds },
            type: { type: 'string', enum: taskTypeIds },
            quantity: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
      checkpoints: {
        type: 'object',
        additionalProperties: false,
        required: ['count', 'layout'],
        properties: {
          count: { type: 'integer', minimum: 0, maximum: 20 },
          layout: { type: 'string', enum: ['loop', 'out_and_back', 'scatter'] },
          targetDistanceKm: { type: 'number', minimum: 0.2, maximum: 100 },
        },
      },
      difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
      mindful: { type: 'boolean' },
      unresolved: { type: 'array', items: { type: 'string', enum: ['start_location', 'date_time', 'team_names'] } },
    },
  };
}

/**
 * The Challenge Agent only composes BUILT-IN (TypeScript) modules. Data modules (cricket, football,
 * custom modules) get their challenges from `challengeFromModule`, which applies the per-minute
 * points budget (ADR-028); letting the intent compiler mix them in would bypass that budget.
 */
export function isChallengeAgentModule(m: { origin?: string }): boolean {
  return (m.origin ?? 'builtin') === 'builtin';
}

/** Lenient JSON extraction: first balanced {...} block (models sometimes add prose or fences). */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('No JSON object found');
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('Unbalanced JSON');
}

export type IntentCheck = { ok: true; intent: Intent } | { ok: false; errors: string[] };

/** zod + registry checks. Only an intent that passes this can reach the compiler. */
export function checkIntent(raw: unknown, registry: ModuleRegistry = defaultRegistry): IntentCheck {
  const parsed = ChallengeIntent.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  const errors: string[] = [];
  const i = parsed.data;
  for (const a of i.activities) {
    const m = registry.get(a.module);
    if (m && !isChallengeAgentModule(m)) {
      errors.push(`activities: "${a.module}" is a data module; create it from the module's page instead`);
      continue;
    }
    if (!m || m.kind !== 'activity') errors.push(`activities: "${a.module}" is not an activity module`);
  }
  for (const t of i.tasks) {
    const tt = registry.taskType(`${t.module}.${t.type}`);
    if (!tt) errors.push(`tasks: "${t.module}.${t.type}" is not a known task type`);
    else if (!isChallengeAgentModule(tt.module)) errors.push(`tasks: "${t.module}" is a data module; create it from the module's page instead`);
  }
  if (i.participants.mode === 'team' && i.participants.count < 2) errors.push('participants: team mode needs at least 2 people');
  return errors.length ? { ok: false, errors } : { ok: true, intent: i };
}
