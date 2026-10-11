import { definitionHash, uuidv7, type BundleDto } from '@trina/contracts';
import { compileOrThrow, ENGINE_VERSION, renderRules } from '@trina/engine';
import { greenSprintDefinition, greenSprintPoints } from '@trina/engine/fixtures';
import { beforeEach, describe, expect, it } from 'vitest';
import { SessionClock } from '../src/core/clock';
import { migrateLocal } from '../src/core/migrations';
import { OfflineStore } from '../src/core/offline-store';
import { evaluatePreflight, GPS_WAIT_MS, type PreflightInput } from '../src/core/preflight';
import { bool, json, Mutex } from '../src/core/sql';
import { FakeClock } from './helpers';
import { nodeSqlite } from './node-sqlite';

const def = compileOrThrow(greenSprintDefinition()).definition;
const P = greenSprintPoints();
const mkBundle = (challengeId: string, version: number, title = 'Green Sprint 60'): BundleDto => {
  const d = { ...JSON.parse(JSON.stringify(def)), meta: { ...def.meta, title } };
  return {
    challengeId, version, definition: d, definitionHash: definitionHash(d), engineMinVersion: 1, maxScore: 310, mapPack: null,
    ruleText: renderRules(compileOrThrow(d)), encouragement: [], participation: { teamId: null, joinedVersion: version }, serverTime: '2026-10-10T10:00:00.000Z',
  };
};

let db: ReturnType<typeof nodeSqlite>;
let store: OfflineStore;
beforeEach(async () => {
  db = nodeSqlite();
  await migrateLocal(db);
  store = new OfflineStore(db);
});

describe('OfflineStore', () => {
  it('keeps versions, lists the latest per challenge, and marks stale', async () => {
    const id = uuidv7();
    await store.saveBundle(mkBundle(id, 1), Date.parse('2026-10-10T10:00:00Z'));
    await store.saveBundle(mkBundle(id, 2, 'Green Sprint v2'), Date.parse('2026-10-10T10:00:01Z'));
    await store.saveBundle(mkBundle(uuidv7(), 1, 'Other'), Date.parse('2026-10-10T10:00:02Z'));
    const list = await store.listDownloaded();
    expect(list.map((c) => c.title)).toEqual(['Other', 'Green Sprint v2']);
    expect((await store.getChallenge(id, 1))!.title).toBe('Green Sprint 60');
    expect((await store.getChallenge(id))!.version).toBe(2);
    await store.markStale(id);
    expect((await store.getChallenge(id))!.stale).toBe(true);
    expect(await store.getChallenge(uuidv7())).toBeNull();
    // Compiled challenges are cached per version.
    const c = (await store.getChallenge(id))!;
    expect(store.compiled(c)).toBe(store.compiled(c));
  });

  it('refuses to store a bundle the engine cannot play', async () => {
    const bad = mkBundle(uuidv7(), 1);
    (bad.definition as any).tasks[0].type = 'cleanup.vacuum_ocean';
    await expect(store.saveBundle(bad, Date.now())).rejects.toThrow(/does not compile/);
  });

  it('meta set/get/delete and leaderboard cache', async () => {
    await store.setMeta('k', 'v');
    expect(await store.getMeta('k')).toBe('v');
    await store.setMeta('k', 'w');
    expect(await store.getMeta('k')).toBe('w');
    await store.setMeta('k', null);
    expect(await store.getMeta('k')).toBeNull();
    expect(await store.cachedLeaderboard('c', 'individual')).toBeNull();
    await store.cacheLeaderboard('c', 'individual', { entries: [1] });
    expect((await store.cachedLeaderboard<{ entries: number[] }>('c', 'individual'))!.data.entries).toEqual([1]);
  });
});

describe('pre-flight, every check', () => {
  const ok = (): PreflightInput => ({
    signedInBefore: true, compiled: compileOrThrow(def), engineMinVersion: 1, participationJoined: true,
    locationPermission: 'granted', notificationPermission: 'granted', cameraPermission: 'granted', activityPermission: 'granted',
    fix: { lat: P.start[1], lng: P.start[0], acc: 8 }, fixWaitedMs: 1000, freeBytes: 5e9, batteryLevel: 0.9,
    serverNowMs: Date.now(), clockSkewMs: 0, hasMapPack: true,
  });
  const status = (i: PreflightInput, id: string) => evaluatePreflight(i).checks.find((c) => c.id === id)?.status;

  it('all green → can start, every check passes', () => {
    const r = evaluatePreflight(ok());
    expect(r.canStart).toBe(true);
    expect(r.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(r.distanceToStartM).toBe(0);
  });
  it.each([
    ['never signed in', { signedInBefore: false }, 'auth'],
    ['not downloaded', { compiled: null }, 'downloaded'],
    ['rules need a newer app', { engineMinVersion: ENGINE_VERSION + 1 }, 'engine'],
    ['not joined', { participationJoined: false }, 'eligibility'],
    ['location denied', { locationPermission: 'denied' }, 'location_permission'],
    ['camera denied (photo tasks)', { cameraPermission: 'denied' }, 'camera'],
    ['no storage', { freeBytes: 10_000_000 }, 'storage'],
    ['GPS never good enough', { fix: { lat: P.start[1], lng: P.start[0], acc: 200 }, fixWaitedMs: GPS_WAIT_MS + 1 }, 'gps_accuracy'],
  ] as const)('blocks when %s', (_l, patch, id) => {
    const i = { ...ok(), ...patch } as PreflightInput;
    expect(status(i, id)).toBe('fail');
    expect(evaluatePreflight(i).canStart).toBe(false);
  });
  it('blocks outside the challenge window (and allows the start grace period)', () => {
    const windowed = { ...def, timing: { ...def.timing, window: { opensAt: new Date(Date.now() + 5 * 60_000).toISOString(), closesAt: new Date(Date.now() + 5 * 3_600_000).toISOString() } } };
    const compiled = compileOrThrow(windowed);
    expect(status({ ...ok(), compiled }, 'window')).toBe('pass'); // within 10-min grace
    expect(status({ ...ok(), compiled, serverNowMs: Date.now() - 3_600_000 }, 'window')).toBe('fail');
    expect(status({ ...ok(), compiled, serverNowMs: Date.now() + 6 * 3_600_000 }, 'window')).toBe('fail');
  });
  it('GPS is "pending" while waiting, never blocks forever silently', () => {
    expect(status({ ...ok(), fix: null, fixWaitedMs: 5000 }, 'gps_accuracy')).toBe('pending');
    expect(status({ ...ok(), fix: null }, 'start_zone')).toBe('pending');
    expect(evaluatePreflight({ ...ok(), fix: null }).canStart).toBe(false);
  });
  it('warnings only: notifications, steps, battery, clock, map, unknown storage', () => {
    const i = { ...ok(), notificationPermission: 'denied', activityPermission: 'unavailable', batteryLevel: 0.05, clockSkewMs: 20 * 60_000, hasMapPack: false, freeBytes: null } as PreflightInput;
    const r = evaluatePreflight(i);
    expect(r.canStart).toBe(true);
    for (const id of ['notifications', 'activity_permission', 'battery', 'clock', 'map', 'storage']) expect(status(i, id)).toBe('warn');
    expect(r.checks.find((c) => c.id === 'activity_permission')!.fix).toBeUndefined();
    expect(status({ ...ok(), clockSkewMs: null }, 'clock')).toBe('warn');
  });
  it('omits the notification row on iOS and the camera row when no photo is needed', () => {
    const noPhotos = compileOrThrow({ ...def, tasks: [], scoring: { ...def.scoring, rules: def.scoring.rules.filter((r) => r.kind !== 'per_task') }, completion: { all: [{ fact: 'checkpoints.required_reached', op: '==', value: 'ALL' }], endZoneRequired: true } });
    const r = evaluatePreflight({ ...ok(), compiled: noPhotos, notificationPermission: 'not_required', cameraPermission: 'denied' });
    expect(r.checks.map((c) => c.id)).not.toContain('notifications');
    expect(r.checks.map((c) => c.id)).not.toContain('camera');
    expect(r.canStart).toBe(true);
  });
});

describe('clock + sql helpers', () => {
  it('converts platform fix times to session mono time', () => {
    const c = new FakeClock(1_000_000);
    const sc = new SessionClock(c, 0, 0);
    c.advance(30_000);
    expect(sc.monoNow()).toBe(30_000);
    expect(sc.monoAtWall(1_010_000)).toBe(10_000);
    expect(sc.monoAtWall(0)).toBe(0); // clamped
  });
  it('bool/json helpers and the mutex', async () => {
    expect([bool(1), bool('1'), bool(true), bool(0), bool(null)]).toEqual([true, true, true, false, false]);
    expect(json('{"a":1}', {})).toEqual({ a: 1 });
    expect(json('{bad', { d: 1 })).toEqual({ d: 1 });
    expect(json(null, 5)).toBe(5);
    const m = new Mutex();
    const order: number[] = [];
    await Promise.all([
      m.run(async () => { await new Promise((r) => setTimeout(r, 20)); order.push(1); }),
      m.run(async () => void order.push(2)),
      m.run(async () => { throw new Error('x'); }).catch(() => order.push(3)),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });
});
