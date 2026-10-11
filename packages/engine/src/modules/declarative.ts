import {
  checkSafety,
  CUSTOM_MODULE_ID,
  definitionHash,
  ModuleDefinition,
  RESERVED_MODULE_PREFIXES,
  type CompileIssue,
  type Difficulty,
  type ModuleDefinitionInput,
  type SafetyConcern,
  type SafetyReport,
  type Verification,
} from '@trina/contracts';
import { z } from 'zod';
import { compileMilestone } from '../milestone-compile';
import type { CompiledMilestone, ModuleDef, TaskTypeDef } from '../types';
import { MOVEMENT_PROFILES, taskLevel } from './profiles';

/**
 * Declarative (data) modules, ADR-023. A ModuleDefinition is DATA: this function validates it and
 * builds an ordinary `ModuleDef` from the closed primitive catalogue. Nothing in the definition is
 * ever executed; fact extractors are generated here from counters only.
 */
export type ModuleCompileResult =
  | { ok: true; module: ModuleDef; definition: ModuleDefinition; milestones: CompiledMilestone[]; issues: CompileIssue[]; risk: SafetyReport }
  | { ok: false; issues: CompileIssue[]; risk: SafetyReport | null };

export type ModuleCompileOptions = {
  /** Ids that a runtime module may not take (built-in + official). */
  reservedIds?: string[];
};

/** Free text in a module, all of it shown to people. Checked by the safety filter. */
export function moduleTexts(d: ModuleDefinition): string[] {
  return [
    d.meta.displayName,
    d.meta.description,
    ...d.counters.map((c) => c.label),
    ...d.taskTypes.flatMap((t) => [t.displayName, ...t.evidence.map((e) => e.hint)]),
    ...d.milestones.flatMap((m) => [m.title, m.description ?? '']),
    d.aiHints.description,
    ...d.aiHints.examples,
  ];
}

export function compileModule(input: unknown, opts: ModuleCompileOptions = {}): ModuleCompileResult {
  const issues: CompileIssue[] = [];
  const err = (path: string, message: string) => issues.push({ path, message, severity: 'error' });
  const warn = (path: string, message: string) => issues.push({ path, message, severity: 'warning' });
  const parsed = ModuleDefinition.safeParse(input);
  if (!parsed.success) {
    for (const i of parsed.error.issues) err(i.path.join('.') || '(root)', i.message);
    return { ok: false, issues, risk: null };
  }
  const d = parsed.data;
  const profile = MOVEMENT_PROFILES[d.movement];

  // Identity
  if (d.origin === 'community') {
    if (!CUSTOM_MODULE_ID.test(d.id)) err('id', 'Custom module ids look like u_<name>_<4 hex>');
    const slug = d.id.replace(/^u_/, '');
    if (RESERVED_MODULE_PREFIXES.some((p) => slug.startsWith(p))) err('id', 'This module id is reserved');
  }
  if (opts.reservedIds?.includes(d.id)) err('id', `Module id "${d.id}" is reserved`);

  // Plausibility can only get stricter.
  if (d.plausibility.maxSpeedMps !== undefined && d.plausibility.maxSpeedMps > profile.maxSpeedMps) {
    err('plausibility.maxSpeedMps', `Max speed for ${d.movement} is ${profile.maxSpeedMps} m/s`);
  }

  // Scoring: weights only; self-reported counters never earn points (anti-farming, ADR-024).
  const counters = new Map(d.counters.map((c) => [c.id, c]));
  d.scoring.counterRules.forEach((r, i) => {
    const c = counters.get(r.counter);
    if (!c) return err(`scoring.counterRules.${i}.counter`, `Unknown counter "${r.counter}"`);
    if (c.verification === 'self_report') err(`scoring.counterRules.${i}`, `"${c.label}" is self-reported, so it can't earn points (titles only)`);
    if (r.capPerSession > c.maxPerSession) err(`scoring.counterRules.${i}.capPerSession`, 'Cap is higher than the counter allows per session');
  });
  if (d.movement !== 'on_foot' && d.movement !== 'human_powered_wheels' && d.scoring.distanceWeight > 0) {
    warn('scoring.distanceWeight', 'Distance is rarely meaningful for this kind of activity');
  }

  // Facts generated from primitives, with verification levels.
  const factLevels: Record<string, Verification> = {};
  const counterMax: Record<string, number> = {};
  for (const c of d.counters) {
    factLevels[`${d.id}.${c.id}`] = 'self_report';
    counterMax[`${d.id}.${c.id}`] = c.maxPerSession;
    if (c.verification !== 'self_report') factLevels[`${d.id}.${c.id}.confirmed`] = c.verification;
  }
  for (const t of d.taskTypes) factLevels[`${d.id}.${t.id}.done_count`] = taskLevel(t.completion);

  // Milestones
  const milestones: CompiledMilestone[] = [];
  d.milestones.forEach((m, i) => {
    const r = compileMilestone(m, { moduleId: d.id, moduleVersion: d.version, factLevels, movement: d.movement, counterMax, pathPrefix: `milestones.${i}.` });
    issues.push(...r.issues);
    if (r.ok) milestones.push(r.milestone);
  });

  // Safety (deterministic, monotonic). Required notes can't be removed by editing.
  // Notes carry concerns found when the module was drafted (e.g. from the prompt), so they keep the risk level.
  const NOTE_CONCERNS: Partial<Record<string, SafetyConcern>> = { no_swimming: 'water', keep_distance_from_animals: 'animals', heat_take_breaks: 'heat' };
  const risk = checkSafety(moduleTexts(d), d.safety.notes.map((n) => NOTE_CONCERNS[n]).filter((c): c is SafetyConcern => !!c));
  if (risk.level === 'blocked') {
    for (const f of risk.findings.filter((x) => x.outcome === 'blocked')) err('safety', `Not allowed: ${f.message} ("${f.term}")`);
  }
  const missing = risk.notes.filter((n) => !d.safety.notes.includes(n));
  if (missing.length) err('safety.notes', `Required safety notes missing: ${missing.join(', ')}`);

  if (issues.some((i) => i.severity === 'error')) return { ok: false, issues, risk };

  const paramShape: Record<string, z.ZodType> = {};
  for (const p of d.params) paramShape[p.key] = z.int().min(p.min).max(p.max).default(p.default);
  const paramsSchema = z.object(paramShape).loose() as unknown as z.ZodType<Record<string, unknown>>;

  const taskTypes: TaskTypeDef[] = d.taskTypes.map((t) => ({
    id: t.id,
    displayName: t.displayName,
    paramsSchema: z.object({}).loose() as unknown as z.ZodType<Record<string, unknown>>,
    completion: t.completion,
    defaultEvidence: t.evidence.map((e) => ({ kind: 'photo' as const, count: e.count, hint: e.hint })),
    defaultPoints: t.weight * 10,
    minTaskSeconds: t.minTaskSeconds,
    evidenceRadiusM: t.evidenceRadiusM,
  }));

  const ids = d.counters.map((c) => `${d.id}.${c.id}`);
  const module: ModuleDef = {
    id: d.id,
    version: d.version,
    displayName: d.meta.displayName,
    icon: d.meta.icon,
    kind: d.movement === 'on_foot' || d.movement === 'human_powered_wheels' ? 'activity' : 'presence',
    paramsSchema,
    taskTypes,
    plausibility: { maxSpeedMps: Math.min(profile.maxSpeedMps, d.plausibility.maxSpeedMps ?? profile.maxSpeedMps) },
    metBySpeed: [{ upToMps: 99, met: profile.movingMet }],
    restMet: profile.restMet,
    typicalSpeedMps: profile.typicalSpeedMps,
    factNames: Object.keys(factLevels),
    factExtractors: ids.length
      ? [
          (state) => {
            const out: Record<string, number> = {};
            for (const c of d.counters) {
              const id = `${d.id}.${c.id}`;
              out[id] = Math.min(c.maxPerSession, state.counters[id] ?? 0);
              if (c.verification !== 'self_report') out[`${id}.confirmed`] = Math.min(c.maxPerSession, state.confirmed[id] ?? 0);
            }
            return out;
          },
        ]
      : [],
    difficulty: (params, level: Difficulty) => {
      const next = { ...params };
      for (const r of d.difficulty) next[r.param] = r[level];
      return next;
    },
    aiHints: { description: d.aiHints.description || d.meta.description, examples: d.aiHints.examples },
    origin: d.origin,
    definitionHash: definitionHash(d),
    descriptor: d,
    counters: d.counters,
    factLevels,
  };
  return { ok: true, module, definition: d, milestones, issues, risk };
}

export function compileModuleOrThrow(input: ModuleDefinitionInput | unknown, opts?: ModuleCompileOptions): ModuleDef {
  const r = compileModule(input, opts);
  if (!r.ok) throw new Error(`Module does not compile: ${r.issues.filter((i) => i.severity === 'error').map((i) => `${i.path}: ${i.message}`).join(', ')}`);
  return r.module;
}
