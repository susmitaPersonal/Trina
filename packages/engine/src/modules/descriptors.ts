import { ModuleDefinition, type MilestoneDefinitionInput, type ModuleDefinitionInput, type Movement, type Venue, type Verification } from '@trina/contracts';
import type { ModuleDef } from '../types';
import { taskLevel, weakest } from './profiles';

/**
 * Built-in TypeScript modules expressed in the Module DSL (design §2.10). The TS code keeps its
 * reducers; the descriptor is the data view used by the UI, the AI prompts and the milestone
 * evaluator, and it must pass the very same `ModuleDefinition` schema as runtime modules.
 */
const SHAPE: Record<string, { icon: ModuleDefinitionInput['meta']['icon']; movement: Movement; venue: Venue }> = {
  walking: { icon: 'walk', movement: 'on_foot', venue: 'any_public' },
  running: { icon: 'run', movement: 'on_foot', venue: 'any_public' },
  cycling: { icon: 'bike', movement: 'human_powered_wheels', venue: 'any_public' },
  cleanup: { icon: 'broom', movement: 'on_foot', venue: 'any_public' },
  tree_care: { icon: 'tree', movement: 'on_foot', venue: 'any_public' },
  mindful: { icon: 'lotus', movement: 'stationary_play', venue: 'park' },
  scavenger: { icon: 'search', movement: 'on_foot', venue: 'any_public' },
  fitness: { icon: 'muscle', movement: 'mixed_play', venue: 'park' },
};

const T = (t: 'bronze' | 'silver' | 'gold', gte: number) => ({ tier: t, gte });

/** Built-in module milestones (design §3.6). */
export const BUILTIN_MILESTONES: Record<string, MilestoneDefinitionInput[]> = {
  walking: [
    { id: 'steps_outside', title: 'Steps outside', window: 'day', measure: { agg: 'sum', fact: 'steps' }, tiers: [T('bronze', 2000), T('silver', 5000), T('gold', 8000)], stat: 'VIT' },
    { id: 'early_km', title: 'Early kilometres', window: 'day', measure: { agg: 'sum', fact: 'distance_m' }, where: { fact: 'start_local_minute', op: '<', value: 480 }, tiers: [{ tier: 'unlock', gte: 3000 }], stat: 'VIT' },
    { id: 'steady_walk', title: 'Steady walk', window: 'session', measure: { agg: 'max', fact: 'moving_time_s' }, tiers: [T('bronze', 900), T('silver', 1800), T('gold', 2700)], stat: 'VIT' },
    { id: 'phone_down', title: 'Phone down', window: 'session', measure: { agg: 'max', fact: 'phone_free_minutes' }, tiers: [T('bronze', 10), T('silver', 20), T('gold', 40)], stat: 'SENSE' },
    { id: 'five_of_seven', title: 'Five of seven', window: 'week', measure: { agg: 'days', fact: 'active_minutes', perDayGte: 20 }, tiers: [T('bronze', 3), T('silver', 5), T('gold', 7)], stat: 'VIT' },
    { id: 'new_park', title: 'New park', window: 'lifetime', measure: { agg: 'distinct_places', fact: 'zone_dwell_s', perPlaceGte: 600 }, tiers: [T('bronze', 1), T('silver', 5), T('gold', 15)], stat: 'SENSE', hidden: true },
  ],
  cycling: [
    { id: 'ride_km', title: 'Ride distance', window: 'day', measure: { agg: 'sum', fact: 'distance_m' }, tiers: [T('bronze', 5000), T('silver', 10000), T('gold', 20000)], stat: 'AGI' },
    { id: 'ride_time', title: 'Time in the saddle', window: 'session', measure: { agg: 'max', fact: 'moving_time_s' }, tiers: [T('bronze', 900), T('silver', 1800), T('gold', 3600)], stat: 'AGI' },
    { id: 'group_ride', title: 'Group ride', window: 'session', measure: { agg: 'max', fact: 'copresence.max_players' }, tiers: [{ tier: 'unlock', gte: 3 }], scope: 'team', stat: 'AURA' },
    { id: 'ride_days', title: 'Riding days', window: 'week', measure: { agg: 'days', fact: 'distance_m', perDayGte: 3000 }, tiers: [T('bronze', 2), T('silver', 3), T('gold', 5)], stat: 'AGI' },
  ],
  cleanup: [
    { id: 'bags', title: 'Bags of litter', window: 'day', measure: { agg: 'sum', fact: 'cleanup.collect_items.done_count' }, tiers: [T('bronze', 1), T('silver', 3), T('gold', 5)], stat: 'AURA' },
    { id: 'cleanup_time', title: 'Clean-up time', window: 'session', measure: { agg: 'max', fact: 'zone_dwell_s' }, tiers: [T('bronze', 1800), T('silver', 2700), T('gold', 5400)], stat: 'AURA' },
    { id: 'crew', title: 'Clean-up crew', window: 'session', measure: { agg: 'max', fact: 'copresence.max_players' }, tiers: [{ tier: 'unlock', gte: 5 }], scope: 'team', stat: 'AURA' },
    { id: 'regular', title: 'Clean-up regular', window: 'lifetime', measure: { agg: 'sessions' }, where: { fact: 'cleanup.collect_items.done_count', op: '>=', value: 1 }, tiers: [T('bronze', 5), T('silver', 10), T('gold', 25)], stat: 'AURA' },
  ],
  tree_care: [
    { id: 'watered', title: 'Trees watered', window: 'day', measure: { agg: 'sum', fact: 'tree_care.water_tree.done_count' }, tiers: [T('bronze', 1), T('silver', 3), T('gold', 5)], stat: 'AURA' },
    { id: 'same_tree', title: 'Same tree, every day', window: 'lifetime', measure: { agg: 'streak_days', fact: 'tree_care.water_tree.done_count', perDayGte: 1, restDaysPerWeek: 1, samePlace: true }, tiers: [T('bronze', 3), T('silver', 5), T('gold', 7)], stat: 'AURA' },
    { id: 'morning_water', title: 'Morning watering', window: 'day', measure: { agg: 'sessions' }, where: { all: [{ fact: 'start_local_minute', op: '<', value: 540 }, { fact: 'tree_care.water_tree.done_count', op: '>=', value: 1 }] }, tiers: [{ tier: 'unlock', gte: 1 }], stat: 'AURA' },
    { id: 'ten_trees', title: 'Tree guardian', window: 'lifetime', measure: { agg: 'distinct_places', fact: 'tree_care.water_tree.done_count', perPlaceGte: 1 }, tiers: [T('bronze', 5), T('silver', 10), T('gold', 25)], stat: 'AURA' },
  ],
  mindful: [
    { id: 'pauses', title: 'Mindful pauses', window: 'day', measure: { agg: 'sum', fact: 'mindful.pause.done_count' }, tiers: [T('bronze', 1), T('silver', 3)], stat: 'SENSE' },
  ],
};

function clampHint(s: string) {
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

/** Fact levels for a built-in module: task done counts by completion; module facts by their tasks. */
export function builtinFactLevels(m: ModuleDef): Record<string, Verification> {
  const levels: Record<string, Verification> = {};
  for (const t of m.taskTypes) levels[`${m.id}.${t.id}.done_count`] = taskLevel(t.completion);
  const taskLevels = m.taskTypes.map((t) => taskLevel(t.completion));
  for (const f of m.factNames ?? []) levels[f] = taskLevels.length ? weakest(taskLevels) : 'sensor';
  return levels;
}

export function builtinDescriptor(m: ModuleDef): ModuleDefinition {
  const shape = SHAPE[m.id] ?? { icon: 'star', movement: 'on_foot', venue: 'any_public' };
  return ModuleDefinition.parse({
    schemaVersion: 'module/1.0',
    id: m.id,
    version: m.version,
    origin: 'builtin',
    meta: { displayName: m.displayName, description: m.aiHints.description.slice(0, 300), icon: shape.icon },
    movement: shape.movement,
    venue: shape.venue,
    team: { min: 1, max: 50 },
    taskTypes: m.taskTypes.map((t) => ({
      id: t.id,
      displayName: t.displayName.slice(0, 40),
      completion: t.completion,
      evidence: t.completion === 'evidence' ? t.defaultEvidence.slice(0, 1).map((e) => ({ kind: 'photo', count: Math.min(3, e.count), hint: clampHint(e.hint) })) : [],
      minTaskSeconds: Math.min(3600, t.minTaskSeconds ?? 0),
      evidenceRadiusM: Math.max(10, Math.min(500, t.evidenceRadiusM ?? 100)),
      weight: Math.max(1, Math.min(5, Math.round(t.defaultPoints / 10))),
    })),
    milestones: BUILTIN_MILESTONES[m.id] ?? [],
    aiHints: { description: m.aiHints.description.slice(0, 200), examples: m.aiHints.examples.slice(0, 5).map((e) => e.slice(0, 80)) },
  });
}

/* ------------------------------------------------------------------ */
/* Generic, cross-module quests (design §3.7): Duolingo-style          */
/* ------------------------------------------------------------------ */

export const GENERIC_MILESTONES: MilestoneDefinitionInput[] = [
  { id: 'q_offline_30', module: '*', title: 'Finish a 30-min offline quest', window: 'day', measure: { agg: 'sessions' }, where: { fact: 'offline_s', op: '>=', value: 1800 }, tiers: [{ tier: 'unlock', gte: 1 }], stat: 'VIT' },
  { id: 'q_outside_45', module: '*', title: 'Spend 45 min outside', window: 'day', measure: { agg: 'sum', fact: 'zone_dwell_s' }, tiers: [{ tier: 'unlock', gte: 2700 }], stat: 'SENSE' },
  { id: 'q_steps_2000', module: '*', title: 'Walk 2,000 steps', window: 'day', measure: { agg: 'sum', fact: 'steps' }, tiers: [{ tier: 'unlock', gte: 2000 }], stat: 'VIT' },
  { id: 'q_photo_1', module: '*', title: 'Take 1 photo proof', window: 'day', measure: { agg: 'sum', fact: 'photo_proofs' }, tiers: [{ tier: 'unlock', gte: 1 }], stat: 'SENSE' },
  { id: 'q_checkpoint_1', module: '*', title: 'Reach a checkpoint', window: 'day', measure: { agg: 'sum', fact: 'checkpoints.reached' }, tiers: [{ tier: 'unlock', gte: 1 }], stat: 'AGI' },
  {
    id: 'q_early_start',
    module: '*',
    title: 'Start a quest before 9 am',
    window: 'day',
    measure: { agg: 'sessions' },
    where: { all: [{ fact: 'start_local_minute', op: '<', value: 540 }, { fact: 'duration_s', op: '>=', value: 900 }] },
    tiers: [{ tier: 'unlock', gte: 1 }],
    stat: 'VIT',
  },
  { id: 'q_phone_down', module: '*', title: '20 phone-free minutes', window: 'day', measure: { agg: 'max', fact: 'phone_free_minutes' }, tiers: [{ tier: 'unlock', gte: 20 }], stat: 'SENSE' },
  { id: 'outdoor_minutes', module: '*', title: 'Minutes outside', window: 'day', measure: { agg: 'sum', fact: 'zone_dwell_s' }, tiers: [T('bronze', 1200), T('silver', 2700), T('gold', 5400)], stat: 'VIT' },
  { id: 'w_offline_3x90', module: '*', title: 'Offline 3 × 90', window: 'week', measure: { agg: 'days', fact: 'offline_s', perDayGte: 5400 }, tiers: [{ tier: 'unlock', gte: 3 }], stat: 'VIT' },
  { id: 'w_quest_days', module: '*', title: 'Quest days this week', window: 'week', measure: { agg: 'days', fact: 'duration_s', perDayGte: 1800 }, tiers: [T('bronze', 3), T('silver', 5)], stat: 'VIT' },
  { id: 'm_quest_days', module: '*', title: '20 quest days this month', window: 'month', measure: { agg: 'days', fact: 'duration_s', perDayGte: 1800 }, tiers: [{ tier: 'unlock', gte: 20 }], stat: 'VIT' },
  { id: 'l_first_offline', module: '*', title: 'First offline quest', window: 'lifetime', measure: { agg: 'sessions' }, where: { fact: 'offline_s', op: '>=', value: 1800 }, tiers: [{ tier: 'unlock', gte: 1 }], stat: 'SENSE' },
  { id: 'l_photos', module: '*', title: 'Photo proofs', window: 'lifetime', measure: { agg: 'sum', fact: 'photo_proofs' }, tiers: [T('bronze', 10), T('silver', 50), T('gold', 100)], stat: 'SENSE' },
];

/** The Daily Quest pool: 3 are picked per day (design §3.7). */
export const DAILY_QUEST_POOL = ['q_offline_30', 'q_outside_45', 'q_steps_2000', 'q_photo_1', 'q_checkpoint_1', 'q_early_start', 'q_phone_down'] as const;
