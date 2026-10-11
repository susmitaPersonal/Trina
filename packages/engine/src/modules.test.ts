/**
 * Every built-in module must compile, score its tasks, scale difficulty deterministically,
 * and respect its plausibility limits.
 */
import { definitionHash, uuidv7, type ChallengeDefinitionInput } from '@trina/contracts';
import { describe, expect, it } from 'vitest';
import { BUILTIN_MODULES, compile, compileOrThrow, defaultRegistry, destinationPoint, evaluate, fold, renderRules, wellness, aggregateTeam, createRegistry } from './index';
import { DEMO_CENTER, SessionBuilder, fakeSha } from './fixtures';

function minimalDefinition(moduleId: string): ChallengeDefinitionInput {
  const m = defaultRegistry.get(moduleId)!;
  const cp = destinationPoint(DEMO_CENTER, 90, 200);
  const activity = m.kind === 'activity' ? [] : [{ id: 'walking', version: 1, params: {} }];
  const tasks = m.taskTypes.map((t, i) => ({
    id: `t${i}`,
    type: `${m.id}.${t.id}`,
    params: {},
    location: { kind: 'checkpoint' as const, ref: 'cp1' },
    evidence: t.defaultEvidence,
    required: true,
  }));
  return {
    schemaVersion: '1.0',
    meta: { title: `Test ${m.id}`, difficulty: 'easy' },
    modules: [{ id: m.id, version: 1, params: {} }, ...activity],
    participants: { min: 1, max: 10 },
    timing: { durationMin: 30 },
    area: { startZone: { type: 'circle', center: DEMO_CENTER, radiusM: 50 } },
    route: { type: 'ordered', checkpointIds: ['cp1'] },
    checkpoints: [{ id: 'cp1', name: 'Spot', geometry: { type: 'circle', center: cp, radiusM: 30 } }],
    tasks,
    scoring: {
      rules: [{ id: 'cp', kind: 'per_checkpoint', points: 10 }, ...tasks.map((t) => ({ id: `r${t.id}`, kind: 'per_task' as const, task: t.id, points: 7 }))],
    },
    completion: { all: [{ fact: 'checkpoints.required_reached', op: '==', value: 'ALL' }] },
  };
}

describe.each(BUILTIN_MODULES.map((m) => m.id))('module %s', (id) => {
  const def = minimalDefinition(id);
  const compiled = compileOrThrow(def);
  const m = defaultRegistry.get(id)!;

  it('compiles a minimal challenge and renders rules', () => {
    expect(compile(def).ok).toBe(true);
    expect(renderRules(compiled).length).toBeGreaterThan(3);
  });

  it('scores the checkpoint and every task (photo or self-report)', () => {
    const cp = compiled.checkpoints.get('cp1')!.geometry.center;
    const b = new SessionBuilder({ challengeId: uuidv7(), definitionHash: definitionHash(compiled.definition), userId: uuidv7(), deviceId: uuidv7(), start: DEMO_CENTER });
    b.start().moveTo(cp, 1.2).wait(20);
    compiled.tasks.forEach((t, tid) => {
      if (t.evidence.length) b.evidence(tid, fakeSha(tid.length + 3));
      b.completeTask(tid);
    });
    b.complete();
    const r = evaluate(compiled, fold(compiled, b.build()));
    expect(r.facts['checkpoints.reached']).toBe(1);
    expect(r.facts['tasks.done']).toBe(compiled.tasks.size);
    expect(r.total).toBe(10 + 7 * compiled.tasks.size);
    expect(r.completed).toBe(true);
  });

  it('has sane plausibility, deterministic difficulty and MET data', () => {
    expect(m.plausibility.maxSpeedMps).toBeGreaterThan(0);
    expect(m.plausibility.maxSpeedMps).toBeLessThanOrEqual(15);
    if (m.difficulty) expect(m.difficulty({}, 'hard')).toEqual(m.difficulty({}, 'hard'));
    if (m.kind === 'activity') expect(m.metBySpeed?.length).toBeGreaterThan(2);
    for (const t of m.taskTypes) expect(t.defaultPoints).toBeGreaterThan(0);
  });
});

describe('registry', () => {
  it('rejects duplicate module ids', () => {
    expect(() => createRegistry([BUILTIN_MODULES[0]!, BUILTIN_MODULES[0]!])).toThrow(/Duplicate/);
  });
  it('resolves task types by full id', () => {
    expect(defaultRegistry.taskType('tree_care.water_tree')?.module.id).toBe('tree_care');
    expect(defaultRegistry.taskType('tree_care.nope')).toBeUndefined();
    expect(defaultRegistry.taskType('garbage')).toBeUndefined();
  });
});

describe('scoring rules', () => {
  it('caps metric rates and applies penalties after grace', () => {
    const def: any = minimalDefinition('walking');
    def.scoring.rules.push({ id: 'd', kind: 'metric_rate', metric: 'distance_m', pointsPer: 2, per: 50, cap: 9 });
    def.scoring.penalties = [{ id: 'gps', kind: 'per_occurrence', fact: 'gps_lost', points: -3, graceCount: 1 }];
    const compiled = compileOrThrow(def);
    const b = new SessionBuilder({ challengeId: uuidv7(), definitionHash: 'a'.repeat(64), userId: uuidv7(), deviceId: uuidv7(), start: DEMO_CENTER });
    b.start().moveTo(destinationPoint(DEMO_CENTER, 0, 600)).emit('GpsSignalLost', {}).emit('GpsSignalLost', {}).emit('GpsSignalLost', {}).complete();
    const r = evaluate(compiled, fold(compiled, b.build()));
    expect(r.breakdown.find((x) => x.ruleId === 'd')!.points).toBe(9);
    expect(r.breakdown.find((x) => x.ruleId === 'gps')!.points).toBe(-6);
  });

  it('team aggregation modes', () => {
    expect(aggregateTeam([10, 20, 30], 'sum')).toBe(60);
    expect(aggregateTeam([10, 20, 30], 'avg')).toBe(20);
    expect(aggregateTeam([10, 20, 30], 'min')).toBe(10);
    expect(aggregateTeam([], 'sum')).toBe(0);
  });

  it('pausing extends the deadline and does not count as elapsed time', () => {
    const compiled = compileOrThrow(minimalDefinition('walking'));
    const b = new SessionBuilder({ challengeId: uuidv7(), definitionHash: 'a'.repeat(64), userId: uuidv7(), deviceId: uuidv7(), start: DEMO_CENTER });
    b.start().advance(10 * 60_000).emit('SessionPaused', {}).advance(40 * 60_000).emit('SessionResumed', {});
    b.moveTo(compiled.checkpoints.get('cp1')!.geometry.center).wait(20).complete();
    const s = fold(compiled, b.build());
    expect(s.checkpoints.cp1!.reached).toBe(true); // reached 50 min in, only 10 min "on the clock"
    expect(evaluate(compiled, s).facts.duration_s as number).toBeLessThan(15 * 60);
  });

  it('movement while paused does not count as distance', () => {
    const compiled = compileOrThrow(minimalDefinition('walking'));
    const b = new SessionBuilder({ challengeId: uuidv7(), definitionHash: 'a'.repeat(64), userId: uuidv7(), deviceId: uuidv7(), start: DEMO_CENTER });
    b.start().emit('SessionPaused', {}).moveTo(destinationPoint(DEMO_CENTER, 0, 800)).emit('SessionResumed', {}).complete();
    expect(fold(compiled, b.build()).distanceM).toBe(0);
  });

  it('organizer confirmation completes a task without evidence; undo reverts', () => {
    const compiled = compileOrThrow(minimalDefinition('cleanup'));
    const b = new SessionBuilder({ challengeId: uuidv7(), definitionHash: 'a'.repeat(64), userId: uuidv7(), deviceId: uuidv7(), start: DEMO_CENTER });
    b.start().moveTo(compiled.checkpoints.get('cp1')!.geometry.center).wait(20).emit('OrganizerConfirmation', { taskId: 't0', confirmedBy: uuidv7() });
    let s = fold(compiled, b.build());
    expect(s.tasks.t0!.status).toBe('done');
    b.emit('TaskUndone', { taskId: 't0' });
    s = fold(compiled, b.build());
    expect(s.tasks.t0!.status).not.toBe('done');
  });
});

describe('wellness edge cases', () => {
  const compiled = compileOrThrow(minimalDefinition('cycling'));
  it('no time → no kcal; heavier → more kcal; invalid weight → approx', () => {
    const b = new SessionBuilder({ challengeId: uuidv7(), definitionHash: 'a'.repeat(64), userId: uuidv7(), deviceId: uuidv7(), start: DEMO_CENTER });
    b.start();
    expect(wellness(compiled, fold(compiled, b.build())).kcalEstimate).toBeNull();
    b.moveTo(destinationPoint(DEMO_CENTER, 45, 3000), 5).complete();
    const s = fold(compiled, b.build());
    const light = wellness(compiled, s, { weightKg: 55 }).kcalEstimate!;
    const heavy = wellness(compiled, s, { weightKg: 95 }).kcalEstimate!;
    expect(heavy).toBeGreaterThan(light);
    expect(wellness(compiled, s, { weightKg: 9999 }).kcalApprox).toBe(true);
    expect(wellness(compiled, s).avgCadenceSpm).not.toBeNull(); // builder adds steps
    expect(wellness(compiled, s, { moodBefore: 7, moodAfter: 0 })).toMatchObject({ moodBefore: null, moodAfter: null });
  });
});
