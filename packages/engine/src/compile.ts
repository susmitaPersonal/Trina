import {
  ChallengeDefinition,
  type ChallengeDefinitionInput,
  type CompileIssue,
  type Condition,
  type LngLat,
  type Task,
} from '@trina/contracts';
import { haversineM, polygonIsClosed, polygonSelfIntersects, distanceOutsideZoneM } from './geo';
import { defaultRegistry } from './modules';
import { BASE_FACT_LEVELS, POINTS_PER_MINUTE_BUDGET, taskLevel } from './modules/profiles';
import type { CompileResult, CompiledChallenge, ModuleDef, ModuleRegistry } from './types';
import type { Verification } from '@trina/contracts';

export const BASE_FACTS = [
  'duration_s',
  'distance_m',
  'moving_time_s',
  'active_minutes',
  'checkpoints.reached',
  'checkpoints.total',
  'checkpoints.required_reached',
  'checkpoints.required_total',
  'tasks.done',
  'tasks.total',
  'tasks.required_done',
  'tasks.required_total',
  'boundary_exits',
  'in_end_zone',
  'completed',
  'steps',
  'gps_lost',
  // engine v2
  'zone_dwell_s',
  'phone_free_minutes',
  'start_local_minute',
  'offline_s',
  'photo_proofs',
] as const;

/** For `value: 'ALL'` conditions: which total a counting fact is compared against. */
export const ALL_TOTALS: Record<string, string> = {
  'checkpoints.reached': 'checkpoints.total',
  'checkpoints.required_reached': 'checkpoints.required_total',
  'tasks.done': 'tasks.total',
  'tasks.required_done': 'tasks.required_total',
};

export const MAX_SCORE_LIMIT = 10_000;

function conditionFacts(c: Condition, out: string[] = []): string[] {
  if ('fact' in c) out.push(c.fact);
  else if ('all' in c) c.all.forEach((x) => conditionFacts(x, out));
  else if ('any' in c) c.any.forEach((x) => conditionFacts(x, out));
  else conditionFacts(c.not, out);
  return out;
}

/**
 * Validates and compiles a challenge definition into an executable form.
 * Pure and deterministic. Errors block publishing; warnings are shown to the creator.
 */
export function compile(input: unknown, registry: ModuleRegistry = defaultRegistry): CompileResult {
  const issues: CompileIssue[] = [];
  const err = (path: string, message: string) => issues.push({ path, message, severity: 'error' });
  const warn = (path: string, message: string) => issues.push({ path, message, severity: 'warning' });

  const parsed = ChallengeDefinition.safeParse(input);
  if (!parsed.success) {
    for (const i of parsed.error.issues) err(i.path.join('.') || '(root)', i.message);
    return { ok: false, issues };
  }
  const def = parsed.data;

  // Modules
  const modules: ModuleDef[] = [];
  const moduleIds = new Set<string>();
  def.modules.forEach((m, i) => {
    const mod = registry.get(m.id);
    if (!mod) return err(`modules.${i}.id`, `Unknown module "${m.id}"`);
    if (moduleIds.has(m.id)) return err(`modules.${i}.id`, `Duplicate module "${m.id}"`);
    moduleIds.add(m.id);
    if (m.version > mod.version) err(`modules.${i}.version`, `Module "${m.id}" v${m.version} is newer than engine (v${mod.version})`);
    if (mod.origin === 'community') {
      // Runtime modules must be pinned to exact content so device and server interpret the same data.
      if (m.version !== mod.version) err(`modules.${i}.version`, `Module "${m.id}" is at v${mod.version}`);
      if (!m.definitionHash) err(`modules.${i}.definitionHash`, `Custom module "${m.id}" must be pinned by definitionHash`);
    }
    if (m.definitionHash && m.definitionHash !== mod.definitionHash) err(`modules.${i}.definitionHash`, `Module "${m.id}" content does not match the pinned version`);
    const p = mod.paramsSchema.safeParse(m.params);
    if (!p.success) err(`modules.${i}.params`, p.error.issues.map((x) => x.message).join('; '));
    modules.push(mod);
  });

  // Unique ids
  const dup = (ids: string[], path: string) => {
    const seen = new Set<string>();
    ids.forEach((id, i) => {
      if (seen.has(id)) err(`${path}.${i}.id`, `Duplicate id "${id}"`);
      seen.add(id);
    });
  };
  dup(def.checkpoints.map((c) => c.id), 'checkpoints');
  dup(def.tasks.map((t) => t.id), 'tasks');
  dup(
    [...def.scoring.rules.map((r) => r.id), ...def.scoring.bonuses.map((r) => r.id), ...def.scoring.penalties.map((r) => r.id)],
    'scoring',
  );

  const checkpoints = new Map(def.checkpoints.map((c) => [c.id, c]));

  def.checkpoints.forEach((c, i) => {
    if (c.geometry.radiusM < 10 || c.geometry.radiusM > 500) err(`checkpoints.${i}.geometry.radiusM`, 'Checkpoint radius must be 10–500 m');
  });
  if (def.area.startZone.radiusM < 20 || def.area.startZone.radiusM > 1000) err('area.startZone.radiusM', 'Start zone radius must be 20–1000 m');

  // Boundary
  const b = def.area.boundary;
  if (b?.type === 'polygon') {
    const ring = b.coordinates[0];
    if (!polygonIsClosed(ring)) err('area.boundary', 'Polygon ring must be closed (first point = last point)');
    else if (polygonSelfIntersects(ring)) err('area.boundary', 'Polygon must not self-intersect');
  }
  if (b) {
    def.checkpoints.forEach((c, i) => {
      if (distanceOutsideZoneM(c.geometry.center, b) > 0) warn(`checkpoints.${i}`, `Checkpoint "${c.name}" is outside the boundary`);
    });
    if (distanceOutsideZoneM(def.area.startZone.center, b) > 0) warn('area.startZone', 'Start zone is outside the boundary');
  }

  // Route
  let routeOrder = def.route.checkpointIds.length ? def.route.checkpointIds : def.checkpoints.map((c) => c.id);
  def.route.checkpointIds.forEach((id, i) => {
    if (!checkpoints.has(id)) err(`route.checkpointIds.${i}`, `Unknown checkpoint "${id}"`);
  });
  routeOrder = routeOrder.filter((id) => checkpoints.has(id));

  // Tasks
  const tasks = new Map<string, Task>();
  def.tasks.forEach((t, i) => {
    const tt = registry.taskType(t.type);
    if (!tt) return err(`tasks.${i}.type`, `Unknown task type "${t.type}"`);
    if (!moduleIds.has(tt.module.id)) err(`tasks.${i}.type`, `Task "${t.type}" needs module "${tt.module.id}" in modules[]`);
    const p = tt.task.paramsSchema.safeParse(t.params);
    if (!p.success) err(`tasks.${i}.params`, p.error.issues.map((x) => x.message).join('; '));
    if (t.location.kind === 'checkpoint' && (!t.location.ref || !checkpoints.has(t.location.ref))) {
      err(`tasks.${i}.location.ref`, 'Task location must reference an existing checkpoint');
    }
    if (t.location.kind === 'in_boundary' && !def.area.boundary) err(`tasks.${i}.location`, 'in_boundary task needs area.boundary');
    const evidence = tt.task.completion === 'evidence' && t.evidence.length === 0 ? tt.task.defaultEvidence : t.evidence;
    tasks.set(t.id, { ...t, params: p.success ? p.data : t.params, evidence, title: t.title ?? tt.task.displayName });
  });

  // Known facts
  const knownFacts = new Set<string>(BASE_FACTS);
  for (const m of modules) for (const f of m.factNames ?? []) knownFacts.add(f);
  for (const id of checkpoints.keys()) knownFacts.add(`checkpoint.${id}.reached`);
  for (const id of tasks.keys()) knownFacts.add(`task.${id}.done`);
  const factLevels: Record<string, Verification> = { ...BASE_FACT_LEVELS };
  for (const m of modules) {
    for (const tt of m.taskTypes) {
      knownFacts.add(`${m.id}.${tt.id}.done_count`);
      factLevels[`${m.id}.${tt.id}.done_count`] = taskLevel(tt.completion);
    }
    Object.assign(factLevels, m.factLevels ?? {});
  }

  const checkFacts = (c: Condition, path: string) => {
    for (const f of conditionFacts(c)) if (!knownFacts.has(f)) err(path, `Unknown fact "${f}"`);
  };
  def.completion.all?.forEach((c, i) => checkFacts(c, `completion.all.${i}`));
  def.completion.any?.forEach((c, i) => checkFacts(c, `completion.any.${i}`));
  def.scoring.bonuses.forEach((bn, i) => checkFacts(bn.when, `scoring.bonuses.${i}.when`));
  def.scoring.penalties.forEach((p, i) => {
    if (!knownFacts.has(p.fact)) err(`scoring.penalties.${i}.fact`, `Unknown fact "${p.fact}"`);
  });
  if (!def.completion.all?.length && !def.completion.any?.length) {
    warn('completion', 'No completion conditions: the challenge completes only when the participant taps Finish');
  }
  if (def.completion.endZoneRequired && !def.area.endZone) err('completion.endZoneRequired', 'endZoneRequired needs area.endZone');

  // Rules + max score
  let maxScore = 0;
  def.scoring.rules.forEach((r, i) => {
    if (r.kind === 'per_checkpoint') {
      const ids = r.checkpointIds ?? [...checkpoints.keys()];
      ids.forEach((id) => {
        if (!checkpoints.has(id)) err(`scoring.rules.${i}.checkpointIds`, `Unknown checkpoint "${id}"`);
      });
      maxScore += r.points * ids.length;
    } else if (r.kind === 'per_task') {
      if (!tasks.has(r.task)) err(`scoring.rules.${i}.task`, `Unknown task "${r.task}"`);
      maxScore += r.points;
    } else if (r.kind === 'per_count') {
      if (!knownFacts.has(r.fact)) err(`scoring.rules.${i}.fact`, `Unknown fact "${r.fact}"`);
      else if ((factLevels[r.fact] ?? 'self_report') === 'self_report') err(`scoring.rules.${i}.fact`, `"${r.fact}" is self-reported, so it can't earn points (titles only)`);
      maxScore += r.cap;
    } else {
      if (r.metric === 'duration_s') warn(`scoring.rules.${i}`, 'Rewarding duration can encourage idling');
      maxScore += r.cap;
    }
  });
  for (const bn of def.scoring.bonuses) maxScore += bn.points;
  if (maxScore > MAX_SCORE_LIMIT) err('scoring', `Max possible score ${maxScore} exceeds ${MAX_SCORE_LIMIT}`);
  // Data modules: points budget per minute by level (beginner 8 / mid 12 / pro 15, ADR-028); never reward duration.
  if (modules.some((m) => m.origin === 'official' || m.origin === 'community')) {
    const budget = POINTS_PER_MINUTE_BUDGET[def.meta.difficulty] * def.timing.durationMin;
    if (maxScore > budget) err('scoring', `Max possible score ${maxScore} is over the ${def.meta.difficulty} budget of ${budget} (${POINTS_PER_MINUTE_BUDGET[def.meta.difficulty]} per minute)`);
    def.scoring.rules.forEach((r, i) => {
      if (r.kind === 'metric_rate' && r.metric === 'duration_s') err(`scoring.rules.${i}`, 'Challenges with data modules cannot reward plain duration');
    });
  }
  if (maxScore === 0) warn('scoring', 'This challenge awards no points');

  // Participants / timing
  if (def.participants.min > def.participants.max) err('participants', 'min must be ≤ max');
  if (def.mode === 'team' && !def.participants.teams) warn('participants.teams', 'Team mode without team settings: one team per join');
  if (def.timing.window) {
    const open = Date.parse(def.timing.window.opensAt);
    const close = Date.parse(def.timing.window.closesAt);
    if (!(close > open)) err('timing.window', 'closesAt must be after opensAt');
    else if (close - open < def.timing.durationMin * 60_000) err('timing.window', 'Window is shorter than the challenge duration');
  }

  // Safety + speed
  const activityModules = modules.filter((m) => m.kind === 'activity');
  const maxSpeedMps =
    def.safety.maxSpeedMps ?? Math.max(4, ...modules.map((m) => m.plausibility.maxSpeedMps));

  // Feasibility (warning only)
  const typical = Math.max(1.0, ...activityModules.map((m) => m.typicalSpeedMps ?? 1.2));
  const path: LngLat[] = [def.area.startZone.center, ...routeOrder.map((id) => checkpoints.get(id)!.geometry.center)];
  path.push(def.area.endZone?.center ?? def.area.startZone.center);
  let routeM = 0;
  for (let i = 1; i < path.length; i++) routeM += haversineM(path[i - 1]!, path[i]!);
  const taskSeconds = [...tasks.values()].reduce((s, t) => s + (registry.taskType(t.type)?.task.minTaskSeconds ?? 0), 0);
  const neededMin = Math.round((routeM / typical + taskSeconds) / 60);
  if (neededMin > def.timing.durationMin) {
    warn('timing.durationMin', `Route (~${(routeM / 1000).toFixed(1)} km) likely needs ~${neededMin} min; duration is ${def.timing.durationMin} min`);
  }

  if (issues.some((i) => i.severity === 'error')) return { ok: false, issues };

  const compiled: CompiledChallenge = {
    definition: def,
    modules,
    maxSpeedMps,
    durationMs: def.timing.durationMin * 60_000,
    checkpoints,
    tasks,
    routeOrder,
    knownFacts,
    factLevels,
    maxScore,
    rules: def.scoring.rules,
  };
  return { ok: true, compiled, issues, maxScore };
}

/** Throws on compile errors. Convenient for fixtures and server code paths that already validated. */
export function compileOrThrow(input: ChallengeDefinitionInput | unknown, registry?: ModuleRegistry): CompiledChallenge {
  const r = compile(input, registry);
  if (!r.ok) throw new Error(`Challenge does not compile: ${r.issues.map((i) => `${i.path}: ${i.message}`).join(', ')}`);
  return r.compiled;
}
