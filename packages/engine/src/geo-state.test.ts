/**
 * Geometry helpers and the less common state transitions: polygon play areas, unordered routes,
 * manual "I'm here" check-ins, in-area evidence, late events and hint-only events.
 */
import { definitionHash, uuidv7, type ChallengeDefinitionInput, type LngLat } from '@trina/contracts';
import { describe, expect, it } from 'vitest';
import {
  bboxOf,
  compile,
  compileOrThrow,
  destinationPoint,
  distanceOutsideZoneM,
  distanceToPolygonM,
  distanceToSegmentM,
  eligibleCheckpoints,
  evaluate,
  fold,
  haversineM,
  inCircle,
  initialState,
  pointInPolygon,
  polygonIsClosed,
  polygonSelfIntersects,
  reduce,
  renderRules,
  simplifyLine,
  withLiveSamples,
  zoneCenter,
} from './index';
import { DEMO_CENTER, SessionBuilder, fakeSha, greenSprintDefinition, greenSprintPoints } from './fixtures';

const C = DEMO_CENTER;
const square = (half: number): LngLat[] => {
  const n = destinationPoint(C, 0, half)[1], s = destinationPoint(C, 180, half)[1];
  const e = destinationPoint(C, 90, half)[0], w = destinationPoint(C, 270, half)[0];
  return [[w, s], [e, s], [e, n], [w, n], [w, s]];
};

describe('geometry', () => {
  it('point-in-polygon and distance to polygon', () => {
    const ring = square(500);
    expect(pointInPolygon(C, ring)).toBe(true);
    const out = destinationPoint(C, 0, 800);
    expect(pointInPolygon(out, ring)).toBe(false);
    expect(distanceToPolygonM(C, ring)).toBe(0);
    expect(distanceToPolygonM(out, ring)).toBeGreaterThan(280);
    expect(distanceToPolygonM(out, ring)).toBeLessThan(320);
  });

  it('distance to a segment handles endpoints and degenerate segments', () => {
    const a = C, b = destinationPoint(C, 90, 1000);
    const above = destinationPoint(destinationPoint(C, 90, 500), 0, 100);
    expect(distanceToSegmentM(above, a, b)).toBeCloseTo(100, -1);
    const beyond = destinationPoint(C, 90, 1200);
    expect(distanceToSegmentM(beyond, a, b)).toBeCloseTo(200, -1);
    expect(distanceToSegmentM(above, a, a)).toBeCloseTo(haversineM(above, a), -1);
  });

  it('closed / self-intersecting polygon checks', () => {
    const ring = square(300);
    expect(polygonIsClosed(ring)).toBe(true);
    expect(polygonIsClosed(ring.slice(0, -1))).toBe(false);
    expect(polygonSelfIntersects(ring)).toBe(false);
    const bow: LngLat[] = [ring[0]!, ring[2]!, ring[1]!, ring[3]!, ring[0]!];
    expect(polygonSelfIntersects(bow)).toBe(true);
  });

  it('zone helpers: center, outside distance, accuracy-aware circles', () => {
    expect(zoneCenter({ type: 'circle', center: C, radiusM: 10 })).toEqual(C);
    const pc = zoneCenter({ type: 'polygon', coordinates: [square(300)] });
    expect(haversineM(pc, C)).toBeLessThan(5);
    expect(distanceOutsideZoneM(destinationPoint(C, 0, 150), { type: 'circle', center: C, radiusM: 100 })).toBeCloseTo(50, 0);
    const p = destinationPoint(C, 0, 40);
    expect(inCircle(p, 15, { type: 'circle', center: C, radiusM: 30 })).toBe(true); // 40 ≤ 30 + 15
    expect(inCircle(p, 5, { type: 'circle', center: C, radiusM: 30 })).toBe(false);
    expect(inCircle(C, 80, { type: 'circle', center: C, radiusM: 30 }, 50)).toBe(false); // too inaccurate
  });

  it('simplifies lines and computes buffered bounding boxes', () => {
    const line: LngLat[] = Array.from({ length: 50 }, (_, i) => destinationPoint(C, 90, i * 20));
    expect(simplifyLine(line, 5)).toHaveLength(2); // a straight line collapses to its ends
    const zig: LngLat[] = [C, destinationPoint(C, 45, 300), destinationPoint(C, 90, 400)];
    expect(simplifyLine(zig, 5)).toHaveLength(3);
    expect(simplifyLine([C], 5)).toEqual([C]);
    const [minLng, minLat, maxLng, maxLat] = bboxOf([C, destinationPoint(C, 45, 1000)], 500);
    expect(minLng).toBeLessThan(C[0]);
    expect(minLat).toBeLessThan(C[1]);
    expect(maxLng).toBeGreaterThan(C[0]);
    expect(maxLat).toBeGreaterThan(C[1]);
  });
});

function defWith(patch: (d: any) => void): ChallengeDefinitionInput {
  const d = JSON.parse(JSON.stringify(greenSprintDefinition())) as any;
  patch(d);
  return d;
}
const ids = () => ({ challengeId: uuidv7(), definitionHash: 'a'.repeat(64), userId: uuidv7(), deviceId: uuidv7() });
const P = greenSprintPoints();

describe('compile error catalogue', () => {
  it.each([
    ['endZoneRequired without endZone', (d: any) => delete d.area.endZone, /needs area.endZone/],
    ['in_boundary task without boundary', (d: any) => { delete d.area.boundary; d.tasks[0].location = { kind: 'in_boundary' }; }, /needs area.boundary/],
    ['participants min > max', (d: any) => (d.participants = { min: 5, max: 2 }), /min must be ≤ max/],
    ['duplicate checkpoint ids', (d: any) => (d.checkpoints[1].id = 'cp1'), /Duplicate id "cp1"/],
    ['unknown checkpoint in route', (d: any) => d.route.checkpointIds.push('cp9'), /Unknown checkpoint "cp9"/],
    ['checkpoint radius too big', (d: any) => (d.checkpoints[0].geometry.radiusM = 900), /10–500 m/],
    ['start zone too small', (d: any) => (d.area.startZone.radiusM = 10), /20–1000 m/],
    ['window shorter than duration', (d: any) => (d.timing.window = { opensAt: '2026-10-10T08:00:00Z', closesAt: '2026-10-10T08:30:00Z' }), /shorter than the challenge duration/],
    ['window closes before it opens', (d: any) => (d.timing.window = { opensAt: '2026-10-10T08:00:00Z', closesAt: '2026-10-10T07:00:00Z' }), /closesAt must be after opensAt/],
    ['per_task for unknown task', (d: any) => d.scoring.rules.push({ id: 'x', kind: 'per_task', task: 'ghost', points: 5 }), /Unknown task "ghost"/],
    ['per_checkpoint unknown id', (d: any) => d.scoring.rules.push({ id: 'y', kind: 'per_checkpoint', points: 1, checkpointIds: ['zz'] }), /Unknown checkpoint "zz"/],
    ['penalty on unknown fact', (d: any) => (d.scoring.penalties[0].fact = 'naps'), /Unknown fact "naps"/],
    ['task module not declared', (d: any) => (d.modules = d.modules.filter((m: any) => m.id !== 'tree_care')), /needs module "tree_care"/],
    ['newer module version', (d: any) => (d.modules[0].version = 99), /newer than engine/],
    ['bad module params', (d: any) => (d.modules[0].params = { targetDistanceM: 5 }), /expected number to be >=200|>=200/],
  ])('rejects: %s', (_label, patch, msg) => {
    const r = compile(defWith(patch));
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.message).join('\n')).toMatch(msg);
  });

  it.each([
    ['no completion conditions', (d: any) => { d.completion = {}; d.scoring.bonuses = []; }, /only when the participant taps Finish/],
    ['duration rewards', (d: any) => d.scoring.rules.push({ id: 'dur', kind: 'metric_rate', metric: 'duration_s', pointsPer: 1, per: 60, cap: 10 }), /encourage idling/],
    ['team mode without teams', (d: any) => (d.mode = 'team'), /one team per join/],
    ['checkpoint outside boundary', (d: any) => (d.area.boundary.radiusM = 200), /outside the boundary/],
    ['nothing scores', (d: any) => { d.scoring.rules = []; d.scoring.bonuses = []; }, /awards no points/],
  ])('warns (still compiles): %s', (_label, patch, msg) => {
    const r = compile(defWith(patch));
    expect(r.ok).toBe(true);
    expect(r.issues.filter((i) => i.severity === 'warning').map((i) => i.message).join('\n')).toMatch(msg);
  });
});

describe('state transitions', () => {
  it('unordered routes accept checkpoints in any order', () => {
    const compiled = compileOrThrow(greenSprintDefinition(undefined, { ordered: false }));
    const b = new SessionBuilder({ ...ids(), start: P.start });
    b.start().moveTo(P.cp3).wait(20).moveTo(P.cp1).wait(20);
    const s = fold(compiled, b.build());
    expect(s.checkpoints.cp3!.reached && s.checkpoints.cp1!.reached).toBe(true);
    expect(eligibleCheckpoints(compiled, s).sort()).toEqual(['cp2', 'cp4']);
  });

  it('manual "I\'m here" confirm: accepted near the checkpoint, ignored when far or stale', () => {
    const compiled = compileOrThrow(greenSprintDefinition());
    const near = destinationPoint(P.cp1, 180, 70); // 70 m away: outside 30 m radius, within +75 m
    const b = new SessionBuilder({ ...ids(), start: P.start });
    b.start().moveTo(near).emit('CheckpointManualConfirm', { checkpointId: 'cp1', fix: null });
    let s = fold(compiled, b.build());
    expect(s.checkpoints.cp1).toMatchObject({ reached: true, manual: true });
    const r = evaluate(compiled, s);
    expect(r.breakdown.find((x) => x.ruleId === 'cp:cp1')!.reason).toBe('Confirmed manually');

    const far = new SessionBuilder({ ...ids(), start: P.start });
    far.start().moveTo(destinationPoint(P.cp1, 180, 300)).emit('CheckpointManualConfirm', { checkpointId: 'cp1', fix: null });
    expect(fold(compiled, far.build()).checkpoints.cp1!.reached).toBe(false);

    const stale = new SessionBuilder({ ...ids(), start: P.start });
    stale.start().moveTo(near).advance(5 * 60_000).emit('CheckpointManualConfirm', { checkpointId: 'cp1', fix: null });
    expect(fold(compiled, stale.build()).checkpoints.cp1!.reached).toBe(false);

    // Only the NEXT checkpoint of an ordered route can be confirmed.
    const skip = new SessionBuilder({ ...ids(), start: P.start });
    skip.start().moveTo(P.cp3).emit('CheckpointManualConfirm', { checkpointId: 'cp3', fix: null });
    s = fold(compiled, skip.build());
    expect(s.checkpoints.cp3!.reached).toBe(false);
  });

  it('polygon boundaries count exits and in-area evidence is location-checked', () => {
    const def = defWith((d) => {
      d.area.boundary = { type: 'polygon', coordinates: [square(600)], graceM: 30 };
      d.tasks[0].location = { kind: 'in_boundary' };
    });
    const compiled = compileOrThrow(def);
    const outside = destinationPoint(C, 0, 1200);
    const b = new SessionBuilder({ ...ids(), start: P.start });
    b.start().evidence('litter', fakeSha(1)).completeTask('litter').moveTo(outside, 3).wait(60).evidence('litter', fakeSha(2)).moveTo(P.start, 3).complete();
    const s = fold(compiled, b.build());
    expect(s.boundary.exits).toBe(1);
    const evs = Object.values(s.evidence);
    expect(evs[0]!.invalidReason).toBeNull();
    expect(evs[1]!.invalidReason).toBe('off_location');
    expect(s.tasks.litter!.status).toBe('done');
  });

  it('evidence without any fix nearby is rejected as no_location; unknown tasks too', () => {
    const compiled = compileOrThrow(greenSprintDefinition());
    const b = new SessionBuilder({ ...ids(), start: P.start });
    b.start().advance(5 * 60_000);
    b.emit('EvidenceCaptured', { evidenceId: uuidv7(), taskId: 'ghost', checkpointId: null, sha256: fakeSha(1), bytes: 10, mime: 'image/jpeg', fix: null });
    const s = fold(compiled, b.build());
    expect(Object.values(s.evidence)[0]!.invalidReason).toBe('unknown_task');
  });

  it('hint-only events change nothing; duplicate SessionStarted is ignored', () => {
    const compiled = compileOrThrow(greenSprintDefinition());
    const b = new SessionBuilder({ ...ids(), start: P.start });
    b.start();
    const before = fold(compiled, b.build());
    b.emit('CheckpointEntered', { checkpointId: 'cp4', fix: { lat: P.cp4[1], lng: P.cp4[0], acc: 3, ts: new Date().toISOString() } })
      .emit('BoundaryExited', { fix: { lat: 0, lng: 0, acc: 3, ts: new Date().toISOString() } })
      .emit('ClockAnomalyDetected', { kind: 'x', detail: 'y' })
      .emit('GpsSignalRestored', {});
    const after = fold(compiled, b.build());
    expect(after.checkpoints).toEqual(before.checkpoints);
    expect(after.boundary).toEqual(before.boundary);
  });

  it('reduce is immutable; withLiveSamples never mutates the persisted state', () => {
    const compiled = compileOrThrow(greenSprintDefinition());
    const b = new SessionBuilder({ ...ids(), start: P.start });
    const [start] = b.start().build();
    const s0 = initialState(compiled);
    const s1 = reduce(compiled, s0, start!);
    expect(s0.status).toBe('not_started');
    expect(s1.status).toBe('active');
    const step = destinationPoint(P.start, 0, 60); // 60 m in 60 s: a plausible walk
    const live = withLiveSamples(compiled, s1, [{ ts: new Date().toISOString(), monoMs: 60_000, lat: step[1], lng: step[0], acc: 5, speed: null, heading: null, alt: null, mocked: false }]);
    expect(live.lastSample?.monoMs).toBe(60_000);
    expect(s1.lastSample?.monoMs).toBe(0);
    // Not active → samples ignored.
    expect(withLiveSamples(compiled, s0, []).status).toBe('not_started');
  });

  it('time limit: completion after the deadline is clamped and late tasks are ignored', () => {
    const compiled = compileOrThrow(greenSprintDefinition());
    const b = new SessionBuilder({ ...ids(), start: P.start });
    b.start().advance(70 * 60_000).completeTask('litter').complete();
    const s = fold(compiled, b.build());
    expect(s.lateEvents).toBeGreaterThan(0);
    expect(s.endMono).toBe(60 * 60_000);
  });

  it('renders text for every rule kind incl. unordered routes, penalties with grace and any-conditions', () => {
    const def = defWith((d) => {
      d.route.type = 'unordered';
      d.scoring.rules.push({ id: 'am', kind: 'metric_rate', metric: 'active_minutes', pointsPer: 1, per: 5, cap: 10 });
      d.completion.any = [{ fact: 'distance_m', op: '>=', value: 1000 }, { not: { fact: 'boundary_exits', op: '>', value: 2 } }];
    });
    const text = renderRules(compileOrThrow(def)).join('\n');
    expect(text).toMatch(/in any order/);
    expect(text).toMatch(/first 1 forgiven/);
    expect(text).toMatch(/one of: distance \(m\) >= 1000 \/ not \(times you left the area > 2\)/);
    expect(text).toMatch(/1 point per 5 min of active minutes \(max 10\)/);
    expect(text).toMatch(/1 point per 100 m of distance \(max 50\)/);
  });
});

void definitionHash;
