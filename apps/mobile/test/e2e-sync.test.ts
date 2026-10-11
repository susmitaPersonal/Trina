/**
 * END-TO-END: phone core (SQLite event log + SyncWorker) ⇄ real Trina server (in-process).
 * Story: join + download online → go OFFLINE → play Green Sprint → finish offline →
 * reconnect with a LOST ACK → auto-sync → server validation → results pulled back to the phone.
 */
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import { TemplateProvider } from '@trina/ai';
import { uuidv7 } from '@trina/contracts';
import { greenSprintDefinition, greenSprintPoints } from '@trina/engine/fixtures';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createContext } from '../../server/src/app';
import { testConfig } from '../../server/src/config';
import type { AppContext } from '../../server/src/platform/context';
import { ApiClient } from '../src/core/api-client';
import { migrateLocal } from '../src/core/migrations';
import { OfflineStore } from '../src/core/offline-store';
import { SessionManager } from '../src/core/session-manager';
import { SyncWorker } from '../src/core/sync-worker';
import { FakeClock, flakyFetch, fsUploader, memoryTokens, stay, tmp, walk, writePhoto } from './helpers';
import { nodeSqlite } from './node-sqlite';

let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let ctx: AppContext;
let baseUrl = '';
let storageDir = '';

beforeAll(async () => {
  const config = testConfig();
  storageDir = config.STORAGE_DIR;
  ctx = await createContext(config, { llm: new TemplateProvider() });
  server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await ctx.db.close();
  await rm(storageDir, { recursive: true, force: true });
});

function phone(fetchImpl: typeof fetch = fetch) {
  const db = nodeSqlite();
  const device = { id: uuidv7(), platform: 'test' as const, appVersion: '0.1.0' };
  const api = new ApiClient({ baseUrl, tokens: memoryTokens(), device, fetchImpl, uploader: fsUploader(fetchImpl) });
  return { db, device, api };
}

describe('offline-first end to end', () => {
  it('plays a whole challenge offline and syncs exactly once after reconnecting', async () => {
    // Organizer creates + publishes Green Sprint 60 (online).
    const org = phone();
    await org.api.register({ email: `org-${uuidv7()}@t.dev`, password: 'correct horse battery', displayName: 'Priya' });
    const created = await org.api.createChallenge(greenSprintDefinition(), uuidv7());
    await org.api.publish(created.id, 1);

    // Participant joins and downloads the offline bundle (online).
    const net = flakyFetch();
    const me = phone(net.fetch);
    await migrateLocal(me.db);
    const auth = await me.api.register({ email: `arjun-${uuidv7()}@t.dev`, password: 'correct horse battery', displayName: 'Arjun' });
    await me.api.patchMe({ shareWellbeing: true });
    await me.api.join(created.id);
    const store = new OfflineStore(me.db);
    const startWall = Date.now() - 2 * 3_600_000; // played 2 hours ago
    const clock = new FakeClock(startWall);
    const bundle = await me.api.bundle(created.id, 1);
    await store.saveBundle(bundle, Date.now());
    const sm = new SessionManager(me.db, store, clock, { userId: auth.user.id, deviceId: me.device.id });
    const worker = new SyncWorker({ db: me.db, api: me.api, store, deviceId: me.device.id, random: () => 0 });

    // ─── GO OFFLINE ───
    net.ctl.online = false;
    const p = greenSprintPoints();
    const dir = tmp();
    const photos = {
      litter: await writePhoto(dir, 'litter', await sharp({ create: { width: 40, height: 30, channels: 3, background: '#2a6' } }).jpeg().toBuffer()),
      tree1: await writePhoto(dir, 'tree1', await sharp({ create: { width: 40, height: 30, channels: 3, background: '#6a2' } }).jpeg().toBuffer()),
      tree2: await writePhoto(dir, 'tree2', await sharp({ create: { width: 40, height: 30, channels: 3, background: '#26a' } }).jpeg().toBuffer()),
    };
    const fixAt = (pt: [number, number]) => ({ lat: pt[1], lng: pt[0], acc: 7, ts: new Date(clock.wallNow()).toISOString() });

    const id = await sm.start({ challengeId: created.id, version: 1, startFix: fixAt(p.start) });
    await sm.setMood(id, 'before', 3);
    let pos = await walk(sm, id, clock, p.start, p.cp1);
    await stay(sm, id, clock, pos, 15);
    pos = await walk(sm, id, clock, pos, p.cp2);
    await stay(sm, id, clock, pos, 150);
    await sm.captureEvidence({ sessionId: id, taskId: 'litter', checkpointId: 'cp2', fileUri: photos.litter.uri, sha256: photos.litter.sha256, bytes: photos.litter.bytes, fix: fixAt(pos) });
    await sm.append(id, 'TaskCompleted', { taskId: 'litter', quantity: 10 });
    for (const [cp, task] of [[p.cp3, 'tree1'], [p.cp4, 'tree2']] as const) {
      pos = await walk(sm, id, clock, pos, cp);
      await stay(sm, id, clock, pos, 40);
      const ph = photos[task];
      await sm.captureEvidence({ sessionId: id, taskId: task, checkpointId: null, fileUri: ph.uri, sha256: ph.sha256, bytes: ph.bytes, fix: fixAt(pos) });
      await sm.append(id, 'TaskCompleted', { taskId: task });
    }
    await sm.append(id, 'AppBackgrounded', {});
    pos = await walk(sm, id, clock, pos, p.start);
    await sm.append(id, 'AppForegrounded', {});
    await stay(sm, id, clock, pos, 10);
    await sm.append(id, 'StepsSample', { cumulative: 2900, delta: 2900, source: 'simulated' });
    await sm.setMood(id, 'after', 5);
    const local = await sm.finish(id, 'rules', { shareWellbeing: true });
    expect(local.score.completed).toBe(true);
    const provisional = local.score.total;
    expect(provisional).toBeGreaterThanOrEqual(280);

    // Sync while offline: nothing lost, nothing acked.
    const offline = await worker.runOnce();
    expect(offline.outcome).toBe('offline');
    const c1 = await worker.counts();
    expect(c1.pendingEvents).toBeGreaterThan(10);
    expect(c1.pendingPhotos).toBe(3);

    // ─── RECONNECT, but the first push response is lost ───
    net.ctl.online = true;
    net.ctl.dropNextResponse = true;
    const lost = await worker.runOnce();
    expect(lost.outcome).toBe('offline');
    expect((await worker.counts()).pendingEvents).toBeGreaterThan(0); // client didn't see the ack

    const ok = await worker.runOnce();
    expect(ok.outcome).toBe('ok');
    expect(ok.duplicates).toBeGreaterThan(0); // server already had the first batch → no double effects
    expect(ok.uploaded).toBe(3);
    expect(await worker.counts()).toMatchObject({ pendingEvents: 0, pendingPhotos: 0, failed: 0 });

    // Server validates (worker job), phone pulls the result.
    await ctx.jobs.drain();
    const pulled = await worker.runOnce();
    expect(pulled.pulled).toBeGreaterThanOrEqual(1);
    const row = await me.db.get<{ verdict: string; final_score_json: string }>('SELECT verdict, final_score_json FROM sessions WHERE id = ?', [id]);
    expect(row!.verdict).toBe('verified');
    const final = JSON.parse(row!.final_score_json);
    // Same engine on device and server → the provisional score is confirmed.
    expect(final.totalPoints).toBe(provisional);
    expect(final.wellness.moodAfter).toBe(5);

    const serverSession = await me.api.session(id);
    expect(serverSession.flags).toEqual([]);
    expect(serverSession.wellness!.phoneFreeMinutes).toBeGreaterThan(0);
    const lb = await me.api.leaderboard(created.id);
    expect(lb.entries[0]).toMatchObject({ name: 'Arjun', points: provisional, verification: 'verified' });

    // Exactly once: server has each event a single time.
    const n = await ctx.db.one<{ n: string }>('SELECT count(*) AS n FROM activity_events WHERE session_id = $1', [id]);
    expect(Number(n!.n)).toBe((await sm.events(id)).length);
  });

  it('queues a join made offline in the outbox and sends it once online (idempotent)', async () => {
    const org = phone();
    await org.api.register({ email: `org2-${uuidv7()}@t.dev`, password: 'correct horse battery', displayName: 'Org' });
    const c = await org.api.createChallenge(greenSprintDefinition(), uuidv7());
    await org.api.publish(c.id, 1);

    const net = flakyFetch();
    const me = phone(net.fetch);
    await migrateLocal(me.db);
    await me.api.register({ email: `s-${uuidv7()}@t.dev`, password: 'correct horse battery', displayName: 'Sam' });
    const store = new OfflineStore(me.db);
    const worker = new SyncWorker({ db: me.db, api: me.api, store, deviceId: me.device.id, random: () => 0 });
    net.ctl.online = false;
    await worker.enqueue('join', 'POST', `/v1/challenges/${c.id}/join`, {});
    expect((await worker.runOnce()).outcome).toBe('offline');
    net.ctl.online = true;
    const r = await worker.runOnce();
    expect(r.outboxSent).toBe(1);
    const detail = await me.api.getChallenge(c.id);
    expect(detail.myParticipation?.status).toBe('joined');
  });

  it('refreshes an expired access token transparently and reports auth_required when refresh is revoked', async () => {
    const me = phone();
    await migrateLocal(me.db);
    const tokens = memoryTokens();
    const api = new ApiClient({ baseUrl, tokens, device: me.device });
    await api.register({ email: `t-${uuidv7()}@t.dev`, password: 'correct horse battery', displayName: 'Tok' });
    tokens.tokens.accessToken = 'expired-or-garbage';
    expect((await api.me()).user.displayName).toBe('Tok');
    tokens.tokens.accessToken = 'garbage';
    tokens.tokens.refreshToken = 'x'.repeat(43);
    const worker = new SyncWorker({ db: me.db, api, store: new OfflineStore(me.db), deviceId: me.device.id });
    expect((await worker.runOnce()).outcome).toBe('auth_required');
  });
});
