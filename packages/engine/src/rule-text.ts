import type { Condition } from '@trina/contracts';
import type { CompiledChallenge } from './types';

const METRIC_LABELS: Record<string, string> = { distance_m: 'distance', active_minutes: 'active minutes', duration_s: 'time', zone_dwell_s: 'time in the play area' };
const METRIC_UNITS: Record<string, string> = { distance_m: ' m', active_minutes: ' min', duration_s: ' s', zone_dwell_s: ' s' };

const FACT_LABELS: Record<string, string> = {
  'checkpoints.required_reached': 'required checkpoints reached',
  'checkpoints.reached': 'checkpoints reached',
  'tasks.required_done': 'required tasks done',
  'tasks.done': 'tasks done',
  completed: 'challenge completed',
  duration_s: 'time (seconds)',
  distance_m: 'distance (m)',
  boundary_exits: 'times you left the area',
  in_end_zone: 'back at the finish',
};

function conditionText(c: Condition): string {
  if ('all' in c) return c.all.map(conditionText).join(' and ');
  if ('any' in c) return c.any.map(conditionText).join(' or ');
  if ('not' in c) return `not (${conditionText(c.not)})`;
  const label = FACT_LABELS[c.fact] ?? c.fact.replace(/[._]/g, ' ');
  if (c.value === 'ALL') return `all ${label}`;
  if (c.value === true && c.op === '==') return label;
  return `${label} ${c.op} ${c.value}`;
}

/**
 * Deterministic, human-readable rules. Always shown next to any AI explanation,
 * so the authoritative text never depends on a model.
 */
export function renderRules(compiled: CompiledChallenge): string[] {
  const d = compiled.definition;
  const lines: string[] = [];
  lines.push(`You have ${d.timing.durationMin} minutes from the moment you start.`);
  lines.push(`Start inside the start zone (${Math.round(d.area.startZone.radiusM)} m circle).`);
  if (compiled.checkpoints.size) {
    const names = compiled.routeOrder.map((id) => compiled.checkpoints.get(id)!.name);
    lines.push(
      d.route.type === 'ordered'
        ? `Reach the checkpoints in order: ${names.join(' → ')}.`
        : `Reach these checkpoints in any order: ${names.join(', ')}.`,
    );
  }
  for (const t of compiled.tasks.values()) {
    const where = t.location.kind === 'checkpoint' ? ` at ${compiled.checkpoints.get(t.location.ref!)?.name}` : '';
    const ev = t.evidence.length ? ` (photo: ${t.evidence[0]!.hint || 'required'})` : '';
    lines.push(`Task: ${t.title ?? t.type}${where}${ev}.`);
  }
  for (const r of d.scoring.rules) {
    if (r.kind === 'per_checkpoint') lines.push(`${r.points} points per checkpoint.`);
    else if (r.kind === 'per_task') lines.push(`${r.points} points for "${compiled.tasks.get(r.task)?.title ?? r.task}".`);
    else if (r.kind === 'per_count') {
      const name = r.label ?? r.fact.replace(/\.confirmed$/, '').split('.').pop()!.replace(/_/g, ' ');
      lines.push(`${r.pointsPer} point${r.pointsPer === 1 ? '' : 's'} per ${r.per > 1 ? `${r.per} ` : ''}${name}${r.fact.endsWith('.confirmed') ? ' (confirmed by another player)' : ''} (max ${r.cap}).`);
    } else lines.push(`${r.pointsPer} point per ${r.per}${METRIC_UNITS[r.metric]} of ${METRIC_LABELS[r.metric]} (max ${r.cap}).`);
  }
  for (const b of d.scoring.bonuses) lines.push(`Bonus ${b.points} points if ${conditionText(b.when)}.`);
  for (const p of d.scoring.penalties) {
    lines.push(`${p.points} points each time: ${FACT_LABELS[p.fact] ?? p.fact}${p.graceCount ? ` (first ${p.graceCount} forgiven)` : ''}.`);
  }
  const done = [...(d.completion.all ?? []).map(conditionText)];
  if (d.completion.any?.length) done.push(`one of: ${d.completion.any.map(conditionText).join(' / ')}`);
  if (d.completion.endZoneRequired) done.push('finish back at the end zone');
  if (done.length) lines.push(`You complete the challenge when: ${done.join('; ')}.`);
  lines.push(`Maximum score: ${compiled.maxScore} points. Speed is never rewarded; stay safe.`);
  return lines;
}
