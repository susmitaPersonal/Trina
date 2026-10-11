import type { ChallengeDefinitionInput, Difficulty, LngLat, ScoringRule } from '@trina/contracts';
import { round6 } from './geo';
import { POINTS_PER_MINUTE_BUDGET } from './modules/profiles';
import type { ModuleDef } from './types';

/** Play-area radius by venue (metres). */
const VENUE_RADIUS: Record<string, number> = { court: 100, park: 400, garden: 300, open_ground: 300, beach: 800, wetland: 800, walkable_street: 1500, any_public: 1000 };

/**
 * Deterministic challenge for a data module (custom or official): play area around the player's
 * pin, one task per task type, scoring from the module's WEIGHTS scaled into the level's budget
 * (beginner 8 / mid 12 / pro 15 points per minute). The AI is not involved.
 */
export function challengeFromModule(
  m: ModuleDef,
  opts: { start: LngLat; durationMin: number; difficulty: Difficulty; title?: string; maxParticipants?: number; team?: boolean },
): ChallengeDefinitionInput {
  const d = m.descriptor;
  if (!d) throw new Error(`Module "${m.id}" has no descriptor`);
  const center: LngLat = [round6(opts.start[0]), round6(opts.start[1])];
  const tasks = d.taskTypes.map((t) => ({
    id: `t_${t.id}`.slice(0, 32),
    type: `${m.id}.${t.id}`,
    title: t.displayName,
    params: {},
    location: { kind: 'in_boundary' as const },
    evidence: t.evidence.map((e) => ({ kind: 'photo' as const, count: e.count, hint: e.hint })),
    required: false,
    scope: 'individual' as const,
  }));

  type Draft = { rule: ScoringRule; max: number };
  const drafts: Draft[] = [];
  for (const t of d.taskTypes) drafts.push({ rule: { id: `task_${t.id}`.slice(0, 32), kind: 'per_task', task: `t_${t.id}`.slice(0, 32), points: t.weight * 10 }, max: t.weight * 10 });
  for (const r of d.scoring.counterRules) {
    const c = d.counters.find((x) => x.id === r.counter)!;
    const pointsPer = r.weight * 2;
    drafts.push({ rule: { id: `count_${r.counter}`.slice(0, 32), kind: 'per_count', fact: `${m.id}.${r.counter}.confirmed`, label: c.label, pointsPer, per: 1, cap: pointsPer * r.capPerSession }, max: pointsPer * r.capPerSession });
  }
  if (d.scoring.dwellWeight > 0) drafts.push({ rule: { id: 'dwell', kind: 'metric_rate', metric: 'zone_dwell_s', pointsPer: d.scoring.dwellWeight, per: 60, cap: d.scoring.dwellWeight * Math.min(60, opts.durationMin) }, max: d.scoring.dwellWeight * Math.min(60, opts.durationMin) });
  if (d.scoring.distanceWeight > 0) drafts.push({ rule: { id: 'distance', kind: 'metric_rate', metric: 'distance_m', pointsPer: d.scoring.distanceWeight, per: 100, cap: d.scoring.distanceWeight * 30 }, max: d.scoring.distanceWeight * 30 });

  // Scale everything down (floor) so the maximum fits the level's budget.
  const budget = POINTS_PER_MINUTE_BUDGET[opts.difficulty] * opts.durationMin;
  const total = drafts.reduce((n, x) => n + x.max, 0);
  const f = total > budget ? budget / total : 1;
  const rules: ScoringRule[] = drafts.map(({ rule }) => {
    if (f === 1) return rule;
    if (rule.kind === 'per_task') return { ...rule, points: Math.max(1, Math.floor(rule.points * f)) };
    if (rule.kind === 'per_count') {
      const pointsPer = Math.max(1, Math.floor(rule.pointsPer * f));
      return { ...rule, pointsPer, cap: Math.floor(rule.cap * f) };
    }
    if (rule.kind === 'metric_rate') return { ...rule, cap: Math.floor(rule.cap * f) };
    return rule;
  });
  // Floors of 1 point may push a tiny budget over: trim caps until it fits (deterministic).
  const maxOf = (r: ScoringRule) => (r.kind === 'per_task' ? r.points : r.kind === 'per_checkpoint' ? 0 : r.cap);
  for (let guard = 0; rules.reduce((n, r) => n + maxOf(r), 0) > budget && guard < 1000; guard++) {
    const i = rules.findIndex((r) => (r.kind === 'metric_rate' || r.kind === 'per_count') && r.cap > 0);
    if (i < 0) break;
    const r = rules[i]!;
    if (r.kind === 'metric_rate' || r.kind === 'per_count') rules[i] = { ...r, cap: r.cap - 1 };
  }

  const params: Record<string, unknown> = {};
  for (const p of d.params) params[p.key] = p.default;
  for (const r of d.difficulty) params[r.param] = r[opts.difficulty];
  const team = opts.team ?? d.team.max > 1;
  return {
    schemaVersion: '1.1',
    meta: { title: (opts.title ?? d.meta.displayName).slice(0, 80), description: d.meta.description, tags: ['custom'], difficulty: opts.difficulty, visibility: 'unlisted', language: 'en' },
    modules: [{ id: m.id, version: m.version, params, ...(m.definitionHash ? { definitionHash: m.definitionHash } : {}) }],
    mode: team ? 'team' : 'individual',
    participants: { min: 1, max: opts.maxParticipants ?? Math.max(2, d.team.max), ...(team ? { teams: { count: 2, sizeMax: Math.max(1, d.team.max) } } : {}) },
    timing: { durationMin: opts.durationMin, startGraceMin: 10, daylightOnly: d.safety.daylightOnly },
    area: { startZone: { type: 'circle', center, radiusM: 75 }, boundary: { type: 'circle', center, radiusM: VENUE_RADIUS[d.venue] ?? 300, graceM: 50 } },
    route: { type: 'free', checkpointIds: [] },
    checkpoints: [],
    tasks,
    scoring: { rules, bonuses: [], penalties: [], teamAggregation: 'sum' },
    completion: { endZoneRequired: false },
    safety: { noSpeedRewards: true },
  };
}
