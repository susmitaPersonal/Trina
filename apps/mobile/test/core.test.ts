import { definitionHash, uuidv7, verifyChain, type BundleDto } from '@trina/contracts';
import { compileOrThrow, renderRules } from '@trina/engine';
import { greenSprintDefinition, greenSprintPoints } from '@trina/engine/fixtures';
import { beforeEach, describe, expect, it } from 'vitest';
import { SessionClock } from '../src/core/clock';
import { migrateLocal } from '../src/core/migrations';
import { OfflineStore } from '../src/core/offline-store';
import { evaluatePreflight, type PreflightInput } from '../src/core/preflight';
import { SessionManager } from '../src/core/session-manager';
import { syncPill } from '../src/core/sync-status';
import { FakeClock, stay, walk } from './helpers';
import { nodeSqlite } from './node-sqlite';

const def = compileOrThrow(greenSprintDefinition()).definition;
const challengeId = uuidv7();
const bundle: BundleDto = {
  challengeId,
  version: 1,
  definition: def,
  definitionHash: definitionHash(def),
  engineMinVersion: 1,
  maxScore: 310,
  mapPack: null,
  ruleText: renderRules(compileOrThrow(def)),
  encouragement: [],
  participation: { teamId: null, joinedVersion: 1 },
  serverTime: '2026-10-09T08:00:00.000Z',
};

let db: ReturnType<typeof nodeSqlite>;
let store: OfflineStore;
let clock: FakeClock;
let sm: SessionManager;
const p = greenSprintPoints();

beforeEach(async () => {
  db = nodeSqlite();
  await migrateLocal(db);
  await migrateLocal(db); // idempotent
  store = new OfflineStore(db);
  clock = new FakeClock(Date.parse('2026-10-09T08:00:05.000Z'));
  sm = new SessionManager(db, store, clock, { userId: uuidv7(), deviceId: uuidv7() });
  await store.saveBundle(bundle, clock.wallNow());
});

describe('offline store', () => {
  it('records the server clock offset at download', async () => {
    const c = await store.getChallenge(challengeId);
    expect(c!.clockOffsetMs).toBe(-5000);
    expect(store.compiled(c!).maxScore).toBe(310);
  });
});

describe('session manager (fully offline)', () => {
  it('writes a gap-free hash-chained log, batches GPS, binds photos, and scores like the server', async () => {
    const id = await sm.start({ challengeId, version: 1, startFix: { lat: p.start[1], lng: p.start[0], acc: 6, ts: new Date(clock.wallNow()).toISOString() } });
    expect(await sm.activeSessionId()).toBe(id);
    await expect(sm.start({ challengeId, version: 1, startFix: { lat: 0, lng: 0, acc: 5, ts: new Date().toISOString() } })).rejects.toThrow(/already in progress/);
    await sm.setMood(id, 'before', 3);

    let pos = await walk(sm, id, clock, p.start, p.cp1);
    await stay(sm, id, clock, pos, 15);
    pos = await walk(sm, id, clock, pos, p.cp2);
    await stay(sm, id, clock, pos, 30);
    // Live state includes unflushed GPS: the checkpoint is already reached.
    let snap = await sm.snapshot(id);
    expect(snap.state.checkpoints.cp2!.reached).toBe(true);
    expect(snap.state.tasks.litter!.status).toBe('available');

    await sm.captureEvidence({ sessionId: id, taskId: 'litter', checkpointId: 'cp2', fileUri: 'file:///a.jpg', sha256: 'a'.repeat(64), bytes: 1000, fix: { lat: pos[1], lng: pos[0], acc: 8, ts: new Date(clock.wallNow()).toISOString() } });
    await sm.append(id, 'TaskCompleted', { taskId: 'litter', quantity: 10 });
    snap = await sm.snapshot(id);
    expect(snap.state.tasks.litter!.status).toBe('done');

    await sm.append(id, 'StepsSample', { cumulative: 1200, delta: 1200, source: 'simulated' });
    await sm.setMood(id, 'after', 5);
    const done = await sm.finish(id, 'manual', { shareWellbeing: true });
    expect(done.state.status).toBe('completed');
    expect(await sm.activeSessionId()).toBeNull();

    const events = await sm.events(id);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(verifyChain(id, events)).toEqual({ ok: true });
    expect(events.filter((e) => e.type === 'LocationBatch').length).toBeGreaterThan(1);
    const monos = events.map((e) => e.monoMs);
    expect([...monos].sort((a, b) => a - b)).toEqual(monos);
    const completed = events.at(-1)!;
    expect(completed.type).toBe('SessionCompleted');
    if (completed.type === 'SessionCompleted') expect(completed.payload.wellness).toEqual({ moodBefore: 3, moodAfter: 5 });
    expect(done.score.facts['checkpoints.reached']).toBe(2);
    expect(done.wellness.steps).toBe(1200);
    // Nothing is in the GPS buffer after finishing.
    expect((await db.get<{ n: number }>('SELECT count(*) AS n FROM location_buffer'))!.n).toBe(0);
    const hist = await sm.history();
    expect(hist[0]!.provisional).toBe(done.score.total);
  });

  it('flags a wall-clock rollback when a session is resumed after an app kill', async () => {
    const id = await sm.start({ challengeId, version: 1, startFix: { lat: p.start[1], lng: p.start[0], acc: 6, ts: new Date(clock.wallNow()).toISOString() } });
    clock.advance(60_000);
    await sm.append(id, 'TaskStarted', { taskId: 'litter' });
    // "App killed", user sets clock back 10 minutes, app restarts with a fresh manager.
    clock.wall -= 10 * 60_000;
    const sm2 = new SessionManager(db, store, clock, { userId: uuidv7(), deviceId: uuidv7() });
    await sm2.append(id, 'AppForegrounded', {});
    const types = (await sm2.events(id)).map((e) => e.type);
    expect(types).toContain('ClockAnomalyDetected');
  });

  it('SessionClock keeps mono continuous across restarts', () => {
    const c = new FakeClock(1_000_000);
    const a = new SessionClock(c, 5000, 990_000);
    expect(a.monoNow()).toBe(15_000);
    expect(a.anomaly).toBeNull();
  });
});

describe('pre-flight', () => {
  const base = (): PreflightInput => ({
    signedInBefore: true,
    compiled: compileOrThrow(def),
    engineMinVersion: 1,
    participationJoined: true,
    locationPermission: 'granted',
    notificationPermission: 'granted',
    cameraPermission: 'granted',
    activityPermission: 'granted',
    fix: { lat: p.start[1], lng: p.start[0], acc: 10 },
    fixWaitedMs: 2000,
    freeBytes: 2_000_000_000,
    batteryLevel: 0.8,
    serverNowMs: Date.now(),
    clockSkewMs: 1000,
    hasMapPack: false,
  });
  it('allows start when blocking checks pass (warnings ok)', () => {
    const r = evaluatePreflight(base());
    expect(r.canStart).toBe(true);
    expect(r.checks.find((c) => c.id === 'map')!.status).toBe('warn');
  });
  it('blocks when outside the start zone, without camera, or with poor GPS', () => {
    expect(evaluatePreflight({ ...base(), fix: { lat: p.cp1[1], lng: p.cp1[0], acc: 10 } }).canStart).toBe(false);
    expect(evaluatePreflight({ ...base(), cameraPermission: 'denied' }).canStart).toBe(false);
    const gps = evaluatePreflight({ ...base(), fix: { lat: p.start[1], lng: p.start[0], acc: 120 }, fixWaitedMs: 31_000 });
    expect(gps.canStart).toBe(false);
    expect(gps.checks.find((c) => c.id === 'gps_accuracy')!.status).toBe('fail');
  });
  it('treats step counting and battery as warnings only', () => {
    const r = evaluatePreflight({ ...base(), activityPermission: 'denied', batteryLevel: 0.1 });
    expect(r.canStart).toBe(true);
  });
});

describe('sync pill copy', () => {
  const counts = { pendingEvents: 0, pendingPhotos: 0, pendingOutbox: 0, failed: 0, waitingForWifi: 0 };
  it('shows the documented states', () => {
    expect(syncPill({ online: false, syncing: false, counts, lastReport: null, awaitingVerdict: 0 }).text).toMatch(/offline\. Your progress is safe/);
    expect(syncPill({ online: true, syncing: true, counts: { ...counts, pendingEvents: 12 }, lastReport: null, awaitingVerdict: 0 }).text).toBe('Syncing 12 activities…');
    expect(syncPill({ online: true, syncing: false, counts: { ...counts, failed: 3 }, lastReport: null, awaitingVerdict: 0 }).text).toBe("3 items couldn't sync. We'll retry automatically.");
    expect(syncPill({ online: true, syncing: false, counts, lastReport: null, awaitingVerdict: 0 }).text).toBe('Everything is synced.');
  });
});
