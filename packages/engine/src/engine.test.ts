import { describe, expect, it } from 'vitest';
import { definitionHash, uuidv7, verifyChain } from '@trina/contracts';
import { compile, compileOrThrow, evaluate, fold, renderRules, wellness, haversineM, destinationPoint, defaultRegistry } from './index';
import { SessionBuilder, fakeSha, greenSprintCleanRun, greenSprintDefinition, greenSprintPoints } from './fixtures';

const def = greenSprintDefinition();
const compiled = compileOrThrow(def);
const ids = { challengeId: uuidv7(), definitionHash: definitionHash(def), userId: uuidv7(), deviceId: uuidv7() };

describe('geo', () => {
  it('haversine and destinationPoint agree', () => {
    const a: [number, number] = [88.35, 22.5115];
    const b = destinationPoint(a, 45, 1000);
    expect(haversineM(a, b)).toBeGreaterThan(999);
    expect(haversineM(a, b)).toBeLessThan(1001);
  });
});

describe('compile', () => {
  it('compiles Green Sprint 60 with max score 310', () => {
    const r = compile(def);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.maxScore).toBe(310);
  });

  it('rejects unknown modules, task types, facts and bad refs', () => {
    const bad = JSON.parse(JSON.stringify(def)) as any;
    bad.modules.push({ id: 'teleporting', version: 1, params: {} });
    bad.tasks[0].type = 'cleanup.vacuum_ocean';
    bad.tasks[1].location.ref = 'nope';
    bad.scoring.bonuses[0].when = { fact: 'vibes', op: '>', value: 3 };
    const r = compile(bad);
    expect(r.ok).toBe(false);
    const msgs = r.issues.map((i) => i.message).join('\n');
    expect(msgs).toMatch(/Unknown module "teleporting"/);
    expect(msgs).toMatch(/Unknown task type/);
    expect(msgs).toMatch(/existing checkpoint/);
    expect(msgs).toMatch(/Unknown fact "vibes"/);
  });

  it('rejects self-intersecting polygons and absurd scores', () => {
    const bad = JSON.parse(JSON.stringify(def)) as any;
    const c = bad.area.startZone.center;
    bad.area.boundary = {
      type: 'polygon',
      graceM: 50,
      coordinates: [[[c[0] - 0.01, c[1] - 0.01], [c[0] + 0.01, c[1] + 0.01], [c[0] + 0.01, c[1] - 0.01], [c[0] - 0.01, c[1] + 0.01], [c[0] - 0.01, c[1] - 0.01]]],
    };
    bad.scoring.bonuses[0].points = 1000;
    bad.scoring.rules[0].points = 1000;
    bad.scoring.rules.push({ id: 'x', kind: 'metric_rate', metric: 'distance_m', pointsPer: 1, per: 1, cap: 5000 });
    const r = compile(bad);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => /self-intersect/.test(i.message))).toBe(true);
    expect(r.issues.some((i) => /exceeds/.test(i.message))).toBe(true);
  });

  it('warns when the route is too long for the duration', () => {
    const d = JSON.parse(JSON.stringify(def)) as any;
    d.timing.durationMin = 10;
    const r = compile(d);
    expect(r.ok).toBe(true);
    expect(r.issues.some((i) => i.severity === 'warning' && /likely needs/.test(i.message))).toBe(true);
  });

  it('every builtin module has AI hints and unique task ids', () => {
    for (const m of defaultRegistry.list()) {
      expect(m.aiHints.description.length).toBeGreaterThan(5);
      expect(new Set(m.taskTypes.map((t) => t.id)).size).toBe(m.taskTypes.length);
    }
  });
});

describe('golden: Green Sprint 60 clean run', () => {
  const run = greenSprintCleanRun(ids);

  it('produces a valid hash chain', () => {
    expect(verifyChain(run.sessionId, run.events)).toEqual({ ok: true });
  });

  it('scores every checkpoint, task and the completion bonus deterministically', () => {
    const s = fold(compiled, run.events);
    const r1 = evaluate(compiled, s);
    const r2 = evaluate(compiled, fold(compiled, [...run.events].reverse()));
    expect(r1.completed).toBe(true);
    expect(r1.facts['checkpoints.reached']).toBe(4);
    expect(r1.facts['tasks.done']).toBe(3);
    expect(r1.facts['cleanup.items_collected']).toBe(10);
    expect(r1.facts['tree_care.trees_watered']).toBe(2);
    expect(r1.facts.distance_m as number).toBeGreaterThan(1500);
    // 100 (checkpoints) + 110 (tasks) + 50 (completion bonus) + distance credit (1 pt / 100 m, ~2.2 km loop)
    const distPts = Math.min(50, Math.floor((r1.facts.distance_m as number) / 100));
    expect(distPts).toBe(21);
    expect(r1.total).toBe(260 + distPts);
    expect(r2).toEqual(r1); // order-independent (sorted by seq)
  });

  it('computes wellness with an approximate kcal when weight is unknown', () => {
    const s = fold(compiled, run.events);
    const w = wellness(compiled, s, { moodBefore: 3, moodAfter: 5 });
    expect(w.steps).toBeGreaterThan(2000);
    expect(w.kcalApprox).toBe(true);
    expect(w.kcalEstimate).toBeGreaterThan(50);
    expect(w.phoneFreeMinutes).toBe(10);
    expect(w.avgCadenceSpm).toBeGreaterThan(60);
    const w80 = wellness(compiled, s, { weightKg: 80 });
    expect(w80.kcalApprox).toBe(false);
    expect(w80.kcalEstimate!).toBeGreaterThan(w.kcalEstimate!);
  });

  it('server-invalidated evidence removes task points and completion', () => {
    const s = fold(compiled, run.events, { invalidEvidence: { [run.evidence.tree2]: 'hash_mismatch' } });
    const r = evaluate(compiled, s, { invalidEvidence: { [run.evidence.tree2]: 'hash_mismatch' } });
    expect(r.completed).toBe(false);
    const tree2 = r.breakdown.find((b) => b.ruleId === 'tree2')!;
    expect(tree2.status).toBe('invalidated');
    expect(r.total).toBe(260 + 21 - 30 - 50);
  });

  it('renders deterministic rule text', () => {
    const lines = renderRules(compiled);
    expect(lines.join('\n')).toMatch(/Lake Gate → Boat Club → Old Banyan → Neem Corner/);
    expect(lines.join('\n')).toMatch(/Maximum score: 310/);
  });
});

describe('golden: cheating and edge cases', () => {
  const p = greenSprintPoints();

  it('ignores mocked and teleporting samples', () => {
    const b = new SessionBuilder({ ...ids, start: p.start });
    b.start().teleport(p.cp1).wait(20).teleport(p.cp2, { mocked: true }).wait(20, 5, { mocked: true }).complete();
    const s = fold(compiled, b.build());
    expect(s.samplesRejected.jump).toBeGreaterThan(0);
    expect(s.samplesRejected.mocked).toBeGreaterThan(0);
    expect(s.checkpoints.cp1!.reached).toBe(false);
    expect(s.checkpoints.cp2!.reached).toBe(false);
  });

  it('enforces route order and locks tasks until their checkpoint', () => {
    const b = new SessionBuilder({ ...ids, start: p.start });
    b.start().moveTo(p.cp2).wait(30).evidence('litter', fakeSha(9)).completeTask('litter').complete();
    const r = evaluate(compiled, fold(compiled, b.build()));
    expect(r.facts['checkpoint.cp2.reached']).toBe(false);
    expect(r.facts['task.litter.done']).toBe(false);
  });

  it('rejects evidence captured far from the task checkpoint', () => {
    const b = new SessionBuilder({ ...ids, start: p.start });
    b.start().moveTo(p.cp1).wait(15).moveTo(p.cp2).wait(30).moveTo(p.start).evidence('litter', fakeSha(9)).completeTask('litter').complete();
    const s = fold(compiled, b.build());
    expect(Object.values(s.evidence)[0]!.invalidReason).toBe('off_location');
    expect(s.tasks.litter!.status).not.toBe('done');
  });

  it('counts boundary exits with hysteresis and applies the penalty after the grace exit', () => {
    const far = destinationPoint(p.start, 0, 1200);
    const b = new SessionBuilder({ ...ids, start: p.start });
    b.start().moveTo(far, 3).wait(60).moveTo(p.start, 3).moveTo(far, 3).wait(60).moveTo(p.start, 3).complete();
    const r = evaluate(compiled, fold(compiled, b.build()));
    expect(r.facts.boundary_exits).toBe(2);
    expect(r.breakdown.find((x) => x.ruleId === 'exits')!.points).toBe(-10);
  });

  it('ignores activity after the time limit', () => {
    const b = new SessionBuilder({ ...ids, start: p.start });
    b.start().advance(61 * 60_000).moveTo(p.cp1).wait(20).complete();
    const s = fold(compiled, b.build());
    expect(s.checkpoints.cp1!.reached).toBe(false);
    expect(evaluate(compiled, s).facts.duration_s).toBe(3600);
  });

  it('does not count GPS jitter while standing still as distance', () => {
    const b = new SessionBuilder({ ...ids, start: p.start });
    b.start().wait(600, 5, { acc: 20 }).complete();
    expect(fold(compiled, b.build()).distanceM).toBe(0);
  });
});
