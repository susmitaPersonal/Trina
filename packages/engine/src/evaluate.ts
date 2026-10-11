import type { Condition } from '@trina/contracts';
import { ALL_TOTALS } from './compile';
import { deadlineMono } from './state';
import type { BreakdownItem, CompiledChallenge, EvaluateOptions, FactValue, Facts, ScoreResult, SessionState } from './types';

/** 2: data modules, counters, confirmations, zone dwell, offline time, milestones (ADR-023/024/029). */
export const ENGINE_VERSION = 2;

export type EvaluateContext = EvaluateOptions & {
  /** Current mono time for live (in-progress) sessions; ignored once a session has ended. */
  nowMono?: number;
};

export function elapsedMs(compiled: CompiledChallenge, s: SessionState, nowMono?: number): number {
  if (s.startMono === null) return 0;
  const end = s.endMono ?? Math.min(nowMono ?? s.lastMono, deadlineMono(compiled, s));
  const ongoingPause = s.pauseStartMono !== null ? Math.max(0, end - s.pauseStartMono) : 0;
  return Math.max(0, Math.min(compiled.durationMs, end - s.startMono - s.pausedMs - ongoingPause));
}

/** Sum of interval lengths after removing `minus` intervals (both lists of [start, end]). */
export function intervalsMinus(intervals: Array<[number, number]>, minus: Array<[number, number]> = []): number {
  let total = 0;
  for (const [a, b] of intervals) {
    let len = Math.max(0, b - a);
    for (const [c, d] of minus) len -= Math.max(0, Math.min(b, d) - Math.max(a, c));
    total += Math.max(0, len);
  }
  return total;
}

/** Local minute of the day at session start (0–1439) using the recorded UTC offset (ADR-025). */
export function startLocalMinute(s: SessionState): number {
  if (!s.startClientTs) return 0;
  const m = Math.floor(Date.parse(s.startClientTs) / 60_000) + (s.tzOffsetMin ?? 0);
  return ((m % 1440) + 1440) % 1440;
}

function isTaskDone(compiled: CompiledChallenge, s: SessionState, id: string, opts: EvaluateOptions): boolean {
  const t = s.tasks[id];
  const def = compiled.tasks.get(id);
  if (!t || !def || t.status !== 'done') return false;
  // Server validation may invalidate evidence after the fact: re-check the evidence requirement.
  const required = def.evidence.reduce((n, r) => n + r.count, 0);
  if (required === 0) return true;
  const valid = t.evidenceIds.filter((e) => !opts.invalidEvidence?.[e] && !s.evidence[e]?.invalidReason).length;
  return valid >= required;
}

export function computeFacts(compiled: CompiledChallenge, s: SessionState, ctx: EvaluateContext = {}): Facts {
  const cps = [...compiled.checkpoints.values()];
  const tasks = [...compiled.tasks.values()];
  const facts: Facts = {
    duration_s: Math.round(elapsedMs(compiled, s, ctx.nowMono) / 1000),
    distance_m: Math.round(s.distanceM),
    moving_time_s: Math.round(s.movingMs / 1000),
    active_minutes: Math.floor(s.movingMs / 60_000),
    'checkpoints.total': cps.length,
    'checkpoints.reached': cps.filter((c) => s.checkpoints[c.id]!.reached).length,
    'checkpoints.required_total': cps.filter((c) => c.required).length,
    'checkpoints.required_reached': cps.filter((c) => c.required && s.checkpoints[c.id]!.reached).length,
    'tasks.total': tasks.length,
    'tasks.done': tasks.filter((t) => isTaskDone(compiled, s, t.id, ctx)).length,
    'tasks.required_total': tasks.filter((t) => t.required).length,
    'tasks.required_done': tasks.filter((t) => t.required && isTaskDone(compiled, s, t.id, ctx)).length,
    boundary_exits: s.boundary.exits,
    in_end_zone: s.inEndZone,
    steps: s.steps ?? 0,
    gps_lost: s.gpsLost,
  };
  const durationMs = Number(facts.duration_s) * 1000;
  const end = s.endMono ?? ctx.nowMono ?? s.lastMono;
  const bgMs = s.backgroundMs + (s.backgroundSinceMono !== null ? Math.max(0, end - s.backgroundSinceMono) : 0);
  const offline = [...s.offlineIntervals, ...(s.offlineSinceMono !== null && end > s.offlineSinceMono ? [[s.offlineSinceMono, end] as [number, number]] : [])];
  facts.zone_dwell_s = Math.floor(s.zoneDwellMs / 1000);
  facts.phone_free_minutes = Math.floor(Math.min(bgMs, durationMs) / 60_000);
  facts.start_local_minute = startLocalMinute(s);
  facts.offline_s = Math.floor(Math.min(intervalsMinus(offline, ctx.onlineMono), durationMs) / 1000);
  facts.photo_proofs = Object.values(s.evidence).filter((ev) => !ev.invalidReason && !ctx.invalidEvidence?.[ev.evidenceId]).length;
  for (const m of compiled.modules) {
    for (const tt of m.taskTypes) {
      const type = `${m.id}.${tt.id}`;
      facts[`${type}.done_count`] = tasks.filter((t) => t.type === type && isTaskDone(compiled, s, t.id, ctx)).length;
    }
  }
  for (const c of cps) facts[`checkpoint.${c.id}.reached`] = s.checkpoints[c.id]!.reached;
  for (const t of tasks) facts[`task.${t.id}.done`] = isTaskDone(compiled, s, t.id, ctx);
  for (const m of compiled.modules) for (const x of m.factExtractors ?? []) Object.assign(facts, x(s, compiled));

  const def = compiled.definition.completion;
  const hasConditions = !!(def.all?.length || def.any?.length);
  let met = hasConditions;
  if (def.all?.length) met = met && def.all.every((c) => evalCondition(c, facts));
  if (def.any?.length) met = met && def.any.some((c) => evalCondition(c, facts));
  if (def.endZoneRequired) met = met && s.inEndZone;
  facts.completed = s.status !== 'abandoned' && (hasConditions ? met : s.status === 'completed');
  return facts;
}

function compare(a: FactValue, op: string, b: FactValue): boolean {
  switch (op) {
    case '==': return a === b;
    case '!=': return a !== b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    default: return false;
  }
}

export function evalCondition(c: Condition, facts: Facts): boolean {
  if ('all' in c) return c.all.every((x) => evalCondition(x, facts));
  if ('any' in c) return c.any.some((x) => evalCondition(x, facts));
  if ('not' in c) return !evalCondition(c.not, facts);
  const left = facts[c.fact];
  if (left === undefined) return false;
  let right: FactValue;
  if (c.value === 'ALL') {
    const totalKey = ALL_TOTALS[c.fact];
    if (!totalKey) return false;
    right = facts[totalKey] as number;
  } else right = c.value;
  return compare(left, c.op, right);
}

/** Deterministic score. The ONLY place points are calculated. */
export function evaluate(compiled: CompiledChallenge, s: SessionState, ctx: EvaluateContext = {}): ScoreResult {
  const facts = computeFacts(compiled, s, ctx);
  const breakdown: BreakdownItem[] = [];

  for (const r of compiled.rules) {
    if (r.kind === 'per_checkpoint') {
      for (const id of r.checkpointIds ?? [...compiled.checkpoints.keys()]) {
        const cp = compiled.checkpoints.get(id)!;
        const st = s.checkpoints[id]!;
        breakdown.push({
          ruleId: `${r.id}:${id}`,
          label: `Checkpoint: ${cp.name}`,
          points: st.reached ? r.points : 0,
          status: st.reached ? 'awarded' : 'not_met',
          ...(st.reached && st.manual ? { reason: 'Confirmed manually' } : {}),
          ...(!st.reached ? { reason: 'Not reached' } : {}),
        });
      }
    } else if (r.kind === 'per_task') {
      const t = compiled.tasks.get(r.task)!;
      const ts = s.tasks[r.task]!;
      const done = facts[`task.${r.task}.done`] === true;
      const invalid = ts.evidenceIds
        .map((id) => ctx.invalidEvidence?.[id] ?? s.evidence[id]?.invalidReason)
        .find((x): x is string => !!x);
      breakdown.push({
        ruleId: r.id,
        label: `Task: ${t.title ?? t.type}`,
        points: done ? r.points : 0,
        status: done ? 'awarded' : invalid ? 'invalidated' : 'not_met',
        ...(done ? {} : { reason: invalid ? `Evidence not accepted (${invalid.replace(/_/g, ' ')})` : ts.status === 'locked' ? 'Checkpoint not reached' : 'Not completed' }),
      });
    } else if (r.kind === 'per_count') {
      const value = Number(facts[r.fact] ?? 0);
      const pts = Math.min(r.cap, Math.floor(value / r.per) * r.pointsPer);
      breakdown.push({
        ruleId: r.id,
        label: r.label ?? `${r.fact} (${r.pointsPer} pt / ${r.per}, max ${r.cap})`,
        points: pts,
        status: pts > 0 ? 'awarded' : 'not_met',
        ...(pts > 0 ? {} : { reason: r.fact.endsWith('.confirmed') ? 'Not confirmed yet' : 'Not counted' }),
      });
    } else {
      const value = facts[r.metric] as number;
      const pts = Math.min(r.cap, Math.floor(value / r.per) * r.pointsPer);
      const name = r.metric === 'distance_m' ? 'Distance' : r.metric === 'active_minutes' ? 'Active minutes' : r.metric === 'zone_dwell_s' ? 'Time in the play area' : 'Time';
      const unit = r.metric === 'distance_m' ? ' m' : r.metric === 'zone_dwell_s' || r.metric === 'duration_s' ? ' s' : '';
      breakdown.push({
        ruleId: r.id,
        label: `${name} (${r.pointsPer} pt / ${r.per}${unit}, max ${r.cap})`,
        points: pts,
        status: pts > 0 ? 'awarded' : 'not_met',
      });
    }
  }

  for (const b of compiled.definition.scoring.bonuses) {
    const ok = evalCondition(b.when, facts);
    breakdown.push({ ruleId: b.id, label: b.label ?? `Bonus: ${b.id}`, points: ok ? b.points : 0, status: ok ? 'awarded' : 'not_met' });
  }
  for (const p of compiled.definition.scoring.penalties) {
    const n = Number(facts[p.fact] ?? 0);
    const count = Math.max(0, n - p.graceCount);
    if (count > 0) {
      breakdown.push({ ruleId: p.id, label: p.label ?? `Penalty: ${p.fact}`, points: p.points * count, status: 'penalty', reason: `${count} × ${p.points}` });
    }
  }

  const total = Math.max(0, breakdown.reduce((sum, b) => sum + b.points, 0));
  return { total, maxScore: compiled.maxScore, completed: facts.completed === true, breakdown, facts, engineVersion: ENGINE_VERSION };
}

/** Team score from member totals. */
export function aggregateTeam(totals: number[], mode: 'sum' | 'avg' | 'min'): number {
  if (totals.length === 0) return 0;
  if (mode === 'sum') return totals.reduce((a, b) => a + b, 0);
  if (mode === 'min') return Math.min(...totals);
  return Math.round(totals.reduce((a, b) => a + b, 0) / totals.length);
}
