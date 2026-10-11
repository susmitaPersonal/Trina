import type { ChallengeDefinitionInput, ChallengeIntent, LngLat } from '@trina/contracts';
import { defaultRegistry, destinationPoint, haversineM, round6, type ModuleRegistry } from '@trina/engine';

export type CompileIntentOptions = {
  /** Chosen by the user on a map. The LLM never supplies coordinates. */
  start: LngLat;
  registry?: ModuleRegistry;
  title?: string;
  description?: string;
};

const DIFF_SCALE = { easy: 0.8, medium: 1, hard: 1.25 } as const;

function titleFor(intent: ChallengeIntent, registry: ModuleRegistry): string {
  if (intent.titleHint?.trim()) return intent.titleHint.trim().slice(0, 60);
  const names = [...intent.activities.map((a) => a.module), ...intent.tasks.map((t) => t.module)]
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((id) => registry.get(id)?.displayName.split(' ')[0] ?? id);
  return `${names.slice(0, 3).join(' & ')} ${intent.durationMin}`.slice(0, 60);
}

/** Deterministic checkpoint geometry: the LLM only says "4 checkpoints, loop, ~3 km". */
export function layoutCheckpoints(start: LngLat, count: number, layout: ChallengeIntent['checkpoints']['layout'], distanceM: number): LngLat[] {
  if (count <= 0) return [];
  const pts: LngLat[] = [];
  // Geometry is clamped so the whole route fits a ≤ 5 km play-area radius (schema limit).
  if (layout === 'out_and_back') {
    const leg = Math.min(4500, distanceM / 2);
    for (let i = 1; i <= count; i++) pts.push(destinationPoint(start, 45, (leg * i) / count));
  } else if (layout === 'scatter') {
    const r = Math.max(150, Math.min(3000, distanceM / 6));
    for (let i = 0; i < count; i++) pts.push(destinationPoint(start, (i * 137.508) % 360, r * (0.5 + (0.5 * (i + 1)) / count)));
  } else {
    // Loop: circle through the start point, checkpoints evenly spaced around it.
    const r = Math.max(120, Math.min(2300, distanceM / (2 * Math.PI)));
    const center = destinationPoint(start, 0, r);
    for (let i = 1; i <= count; i++) pts.push(destinationPoint(center, (180 + (360 * i) / (count + 1)) % 360, r));
  }
  return pts.map(([lng, lat]) => [round6(lng), round6(lat)] as LngLat);
}

/**
 * Expands a small, validated ChallengeIntent into a full ChallengeDefinition using module defaults.
 * Pure and deterministic: same intent + start → same definition.
 */
export function compileIntent(intent: ChallengeIntent, opts: CompileIntentOptions): ChallengeDefinitionInput {
  const registry = opts.registry ?? defaultRegistry;
  const start = opts.start;
  const activityMods = intent.activities.map((a) => registry.get(a.module)!).filter(Boolean);
  const speed = Math.max(1, ...activityMods.map((m) => m.typicalSpeedMps ?? 1.2));
  const scale = DIFF_SCALE[intent.difficulty];

  // Distance budget: ~45% of the time moving at typical speed (rest is tasks/pauses), scaled by difficulty.
  const distanceM = Math.round(intent.checkpoints.targetDistanceKm ? intent.checkpoints.targetDistanceKm * 1000 : speed * intent.durationMin * 60 * 0.45 * scale);

  // Tasks
  type T = NonNullable<ChallengeDefinitionInput['tasks']>[number];
  const tasks: T[] = [];
  const perCheckpoint: T[] = [];
  for (const it of intent.tasks) {
    const tt = registry.taskType(`${it.module}.${it.type}`);
    if (!tt) continue;
    const q = it.quantity ?? 1;
    if (it.module === 'cleanup') {
      tasks.push({
        id: `t${tasks.length + perCheckpoint.length + 1}`,
        type: `${it.module}.${it.type}`,
        title: `Collect ${q} pieces of litter`,
        params: { quantity: q },
        location: { kind: 'in_boundary' },
        evidence: tt.task.defaultEvidence,
        required: true,
      });
    } else {
      for (let k = 0; k < Math.min(q, 10); k++) {
        perCheckpoint.push({
          id: `t${tasks.length + perCheckpoint.length + 1}`,
          type: `${it.module}.${it.type}`,
          title: q > 1 ? `${tt.task.displayName} (${k + 1}/${q})` : tt.task.displayName,
          params: {},
          location: { kind: 'checkpoint' },
          evidence: tt.task.defaultEvidence,
          required: true,
        });
      }
    }
  }

  const cpCount = Math.min(20, Math.max(intent.checkpoints.count, perCheckpoint.length));
  const pts = layoutCheckpoints(start, cpCount, intent.checkpoints.layout, distanceM);
  const checkpoints = pts.map((center, i) => ({
    id: `cp${i + 1}`,
    name: `Checkpoint ${i + 1}`,
    geometry: { type: 'circle' as const, center, radiusM: 30 },
    required: true,
    dwellSec: 5,
    maxAccuracyM: 40,
  }));
  // Checkpoint-bound tasks go to the later checkpoints first (spread along the route).
  perCheckpoint.forEach((t, i) => {
    const idx = cpCount - perCheckpoint.length + i;
    t.location = { kind: 'checkpoint', ref: checkpoints[Math.max(0, idx)]!.id };
  });
  if (intent.mindful) {
    for (const type of ['pause', 'notice'] as const) {
      perCheckpoint.push({ id: `m_${type}`, type: `mindful.${type}`, params: {}, location: { kind: 'anywhere' }, evidence: [], required: false });
    }
  }
  const allTasks = [...tasks, ...perCheckpoint];

  const moduleIds = [...new Set([...intent.activities.map((a) => a.module), ...allTasks.map((t) => t.type.split('.')[0]!)])];
  const maxR = Math.max(200, ...pts.map((p) => haversineM(start, p)));
  const cpPoints = Math.round(20 * scale);
  const distanceCap = Math.min(100, Math.max(10, Math.round(distanceM / 100)));

  const def: ChallengeDefinitionInput = {
    schemaVersion: '1.0',
    meta: {
      title: opts.title ?? titleFor(intent, registry),
      description: opts.description ?? '',
      tags: moduleIds,
      difficulty: intent.difficulty,
      visibility: 'unlisted',
      language: 'en',
    },
    modules: moduleIds.map((id) => {
      const m = registry.get(id)!;
      const intensity = intent.activities.find((a) => a.module === id)?.intensity ?? intent.difficulty;
      const params = m.kind === 'activity' && m.difficulty ? m.difficulty({}, intensity) : {};
      return { id, version: m.version, params };
    }),
    mode: intent.participants.mode,
    participants: {
      min: 1,
      max: Math.max(intent.participants.count, 1),
      ...(intent.participants.mode === 'team'
        ? { teams: { count: intent.participants.teams ?? 1, sizeMax: Math.ceil(intent.participants.count / (intent.participants.teams ?? 1)) } }
        : {}),
    },
    timing: { durationMin: intent.durationMin, startGraceMin: 10, daylightOnly: true },
    area: {
      startZone: { type: 'circle', center: start, radiusM: 75 },
      boundary: { type: 'circle', center: start, radiusM: Math.min(5000, Math.round(maxR + 300)), graceM: 50 },
      ...(intent.checkpoints.layout !== 'scatter' || cpCount === 0 ? { endZone: { type: 'circle' as const, center: start, radiusM: 75 } } : {}),
    },
    route: { type: intent.checkpoints.layout === 'scatter' ? 'unordered' : 'ordered', checkpointIds: checkpoints.map((c) => c.id) },
    checkpoints,
    tasks: allTasks,
    scoring: {
      rules: [
        ...(cpCount ? [{ id: 'cp', kind: 'per_checkpoint' as const, points: cpPoints }] : []),
        ...allTasks.map((t) => ({
          id: `r_${t.id}`,
          kind: 'per_task' as const,
          task: t.id,
          points: Math.round((registry.taskType(t.type)?.task.defaultPoints ?? 10) * (t.type.startsWith('mindful') ? 1 : scale)),
        })),
        { id: 'dist', kind: 'metric_rate' as const, metric: 'distance_m' as const, pointsPer: 1, per: 100, cap: distanceCap },
      ],
      bonuses: [{ id: 'finish', kind: 'condition', label: `Completed within ${intent.durationMin} minutes`, when: { fact: 'completed', op: '==', value: true }, points: 50 }],
      penalties: [{ id: 'exits', kind: 'per_occurrence', label: 'Left the play area', fact: 'boundary_exits', points: -10, graceCount: 1 }],
      teamAggregation: 'sum',
    },
    completion: {
      all: [
        ...(cpCount ? [{ fact: 'checkpoints.required_reached', op: '==' as const, value: 'ALL' as const }] : []),
        ...(allTasks.some((t) => t.required) ? [{ fact: 'tasks.required_done', op: '==' as const, value: 'ALL' as const }] : []),
      ],
      endZoneRequired: intent.checkpoints.layout !== 'scatter' && cpCount > 0,
    },
    safety: { noSpeedRewards: true },
  };
  if (!def.completion!.all!.length) delete def.completion!.all;
  return def;
}
