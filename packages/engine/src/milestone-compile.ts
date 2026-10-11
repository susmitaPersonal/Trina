import { MilestoneDefinition, type CompileIssue, type Condition, type Movement, type Verification } from '@trina/contracts';
import { BASE_FACT_LEVELS, SERVER_ONLY_FACTS, weakest } from './modules/profiles';
import type { CompiledMilestone } from './types';

/**
 * Milestone validation (design §3.4). Pure; no imports from the rest of the engine so module
 * registration (which compiles official data modules at import time) never hits an import cycle.
 */

/** Facts a milestone may never use (they reward risk or punish bad GPS). */
const FORBIDDEN = new Set(['boundary_exits', 'gps_lost', 'in_end_zone']);
/** Facts allowed only inside `where` (filters), not as the measured value. */
const WHERE_ONLY = new Set(['start_local_minute', 'completed']);

type Bound = { min: number; maxDaily: number };
/** Thresholds per fact family for session/day windows: no rewards beyond healthy daily amounts. */
function boundFor(fact: string, movement: Movement | null, counterMax: Record<string, number>): Bound | null {
  if (fact === 'zone_dwell_s' || fact === 'moving_time_s' || fact === 'duration_s' || fact === 'offline_s') return { min: 300, maxDaily: 7200 };
  if (fact === 'active_minutes' || fact === 'phone_free_minutes') return { min: 5, maxDaily: 120 };
  if (fact === 'steps') return { min: 500, maxDaily: 15_000 };
  if (fact === 'distance_m') return { min: 200, maxDaily: movement === 'human_powered_wheels' || movement === null ? 40_000 : 15_000 };
  const base = fact.replace(/\.confirmed$/, '');
  if (counterMax[base] !== undefined) return { min: 1, maxDaily: counterMax[base]! };
  return null;
}

function conditionFacts(c: Condition, out: Array<{ fact: string; value: unknown; op: string }> = []) {
  if ('fact' in c) out.push({ fact: c.fact, value: c.value, op: c.op });
  else if ('all' in c) c.all.forEach((x) => conditionFacts(x, out));
  else if ('any' in c) c.any.forEach((x) => conditionFacts(x, out));
  else conditionFacts(c.not, out);
  return out;
}

export type MilestoneCompileContext = {
  moduleId: string;
  moduleVersion: number;
  /** Facts the module produces (with levels); base + server-only facts are always available. */
  factLevels: Record<string, Verification>;
  movement: Movement | null;
  counterMax?: Record<string, number>;
  pathPrefix?: string;
};

export function compileMilestone(input: unknown, ctx: MilestoneCompileContext): { ok: true; milestone: CompiledMilestone; issues: CompileIssue[] } | { ok: false; issues: CompileIssue[] } {
  const issues: CompileIssue[] = [];
  const at = (p: string) => `${ctx.pathPrefix ?? ''}${p}`;
  const err = (p: string, message: string) => issues.push({ path: at(p), message, severity: 'error' });
  const parsed = MilestoneDefinition.safeParse(input);
  if (!parsed.success) {
    for (const i of parsed.error.issues) err(i.path.join('.') || '(root)', i.message);
    return { ok: false, issues };
  }
  const m = parsed.data;
  const levels: Record<string, Verification> = { ...BASE_FACT_LEVELS, ...SERVER_ONLY_FACTS, ...ctx.factLevels };
  const used: Verification[] = [];
  let serverOnly = false;
  const check = (fact: string, path: string, asMeasure: boolean) => {
    if (FORBIDDEN.has(fact)) return err(path, `Milestones can't use "${fact}"`);
    if (asMeasure && WHERE_ONLY.has(fact)) return err(path, `"${fact}" can only be used to filter sessions (where)`);
    const lvl = levels[fact];
    if (!lvl) return err(path, `Unknown fact "${fact}"`);
    used.push(lvl);
    if (SERVER_ONLY_FACTS[fact]) serverOnly = true;
  };
  if ('fact' in m.measure) check(m.measure.fact, 'measure.fact', true);
  for (const c of m.where ? conditionFacts(m.where) : []) {
    check(c.fact, 'where', false);
    if (c.fact === 'start_local_minute' && typeof c.value === 'number' && (c.value < 300 || c.value > 1140)) {
      err('where', 'Time-of-day filters must stay in daylight (05:00–19:00)');
    }
  }

  // Bounds (session/day windows only): no rewards beyond healthy daily amounts.
  if ((m.window === 'session' || m.window === 'day') && (m.measure.agg === 'sum' || m.measure.agg === 'max')) {
    const b = boundFor(m.measure.fact, ctx.movement, ctx.counterMax ?? {});
    if (b) {
      m.tiers.forEach((t, i) => {
        if (t.gte < b.min) err(`tiers.${i}.gte`, `Threshold ${t.gte} is too small for ${m.measure.agg === 'sum' || m.measure.agg === 'max' ? (m.measure as { fact: string }).fact : ''} (min ${b.min})`);
        if (t.gte > b.maxDaily) err(`tiers.${i}.gte`, `Threshold ${t.gte} is more than is healthy in a day (max ${b.maxDaily})`);
      });
    }
  }
  if (m.measure.agg === 'streak_days') {
    m.tiers.forEach((t, i) => {
      if (t.gte < 2) err(`tiers.${i}.gte`, 'A streak needs at least 2 days');
      if (t.gte > 30 && m.window !== 'lifetime') err(`tiers.${i}.gte`, 'Streaks longer than 30 days are lifetime titles only');
    });
  }
  if (m.measure.agg === 'days') {
    const maxDays = m.window === 'week' ? 7 : m.window === 'month' ? 31 : 3650;
    m.tiers.forEach((t, i) => {
      if (t.gte > maxDays) err(`tiers.${i}.gte`, `At most ${maxDays} days fit in a ${m.window}`);
    });
  }
  const moduleId = m.module ?? ctx.moduleId;
  if (moduleId !== ctx.moduleId) err('module', `Milestone belongs to "${ctx.moduleId}"`);
  if (issues.some((i) => i.severity === 'error')) return { ok: false, issues };
  return {
    ok: true,
    issues,
    milestone: {
      key: `${ctx.moduleId}@${ctx.moduleVersion}:${m.id}`,
      moduleId: ctx.moduleId,
      moduleVersion: ctx.moduleVersion,
      def: m,
      verification: weakest(used.length ? used : ['sensor']),
      serverOnly,
    },
  };
}
