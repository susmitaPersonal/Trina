import { definitionHash, uuidv7, type BundleDto, type PushRequest, type PushResponse } from '@trina/contracts';
import { compileOrThrow, renderRules } from '@trina/engine';
import { greenSprintDefinition, greenSprintPoints } from '@trina/engine/fixtures';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiClient, ApiError, AuthRequiredError, NetworkError } from '../src/core/api-client';
import { backoffMs } from '../src/core/clock';
import { migrateLocal } from '../src/core/migrations';
import { OfflineStore } from '../src/core/offline-store';
import { SessionManager } from '../src/core/session-manager';
import { relativeTime, syncPill } from '../src/core/sync-status';
import { SyncWorker } from '../src/core/sync-worker';
import { FakeClock, memoryTokens } from './helpers';
import { nodeSqlite } from './node-sqlite';

const def = compileOrThrow(greenSprintDefinition()).definition;
const challengeId = uuidv7();
const bundle: BundleDto = {
  challengeId, version: 1, definition: def, definitionHash: definitionHash(def), engineMinVersion: 1, maxScore: 310, mapPack: null,
  ruleText: renderRules(compileOrThrow(def)), encouragement: [], participation: { teamId: null, joinedVersion: 1 }, serverTime: new Date().toISOString(),
};
const P = greenSprintPoints();

/** Scriptable fake server for the sync worker. */
class FakeApi {
  pushes: PushRequest[] = [];
  uploads: string[] = [];
  requests: { method: string; path: string; key?: string }[] = [];
  pushMode: 'ack' | 'offline' | 'reject_all' | 'retryable' = 'ack';
  uploadMode: 'ok' | 'conflict' | 'offline' | 'server_error' | 'not_found' = 'ok';
  requestMode: 'ok' | 'bad_request' | 'offline' = 'ok';
  changes: { kind: 'session_result'; id: string; data: any }[] = [];

  async push(body: PushRequest): Promise<PushResponse> {
    this.pushes.push(body);
    if (this.pushMode === 'offline') throw new NetworkError();
    const s = body.sessions[0]!;
    const seqs = s.events.map((e) => e.seq as number);
    const rejected =
      this.pushMode === 'reject_all'
        ? s.events.map((e) => ({ eventId: String(e.eventId), code: 'SCHEMA_INVALID', retryable: false }))
        : this.pushMode === 'retryable'
          ? s.events.map((e) => ({ eventId: String(e.eventId), code: 'SESSION_UNKNOWN', retryable: true }))
          : [];
    const evidence = s.events.filter((e) => e.type === 'EvidenceCaptured').map((e) => (e.payload as { evidenceId: string }).evidenceId);
    return {
      batchId: body.batchId,
      serverTime: new Date().toISOString(),
      results: [{ sessionId: s.sessionId, ackedThroughSeq: this.pushMode === 'ack' ? Math.max(...seqs) : 0, accepted: this.pushMode === 'ack' ? seqs.length : 0, duplicates: 0, rejected, missingSeqs: [], evidenceNeeded: evidence }],
    };
  }
  async uploadEvidence(a: { evidenceId: string }): Promise<'uploaded' | 'conflict'> {
    this.uploads.push(a.evidenceId);
    if (this.uploadMode === 'offline') throw new NetworkError();
    if (this.uploadMode === 'server_error') throw new ApiError(503, { code: 'INTERNAL' });
    if (this.uploadMode === 'not_found') throw new ApiError(404, { code: 'NOT_FOUND' });
    return this.uploadMode === 'conflict' ? 'conflict' : 'uploaded';
  }
  async request<T>(method: string, path: string, _body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    this.requests.push({ method, path, key: headers['Idempotency-Key'] });
    if (this.requestMode === 'offline') throw new NetworkError();
    if (this.requestMode === 'bad_request') throw new ApiError(409, { code: 'CHALLENGE_FULL' });
    return undefined as T;
  }
  async pull(cursor: string) {
    const changes = cursor === '0' ? this.changes : [];
    return { changes, cursor: changes.length ? '1' : cursor, serverTime: new Date().toISOString() };
  }
}

let db: ReturnType<typeof nodeSqlite>;
let store: OfflineStore;
let sm: SessionManager;
let api: FakeApi;
let now: number;
let worker: SyncWorker;
let photosAllowed = true;

beforeEach(async () => {
  db = nodeSqlite();
  await migrateLocal(db);
  store = new OfflineStore(db);
  const clock = new FakeClock(Date.now());
  sm = new SessionManager(db, store, clock, { userId: uuidv7(), deviceId: uuidv7() });
  await store.saveBundle(bundle, Date.now());
  api = new FakeApi();
  now = 1_000_000;
  photosAllowed = true;
  worker = new SyncWorker({ db, api: api as never, store, deviceId: uuidv7(), now: () => now, random: () => 1, photosAllowed: () => photosAllowed });
});

async function sessionWithPhoto() {
  const id = await sm.start({ challengeId, version: 1, startFix: { lat: P.start[1], lng: P.start[0], acc: 5, ts: new Date().toISOString() } });
  await sm.captureEvidence({ sessionId: id, taskId: 'litter', checkpointId: null, fileUri: '/tmp/x.jpg', sha256: 'a'.repeat(64), bytes: 10, fix: null });
  await sm.finish(id, 'manual', { shareWellbeing: false });
  return id;
}

describe('SyncWorker', () => {
  it('pushes, uploads, pulls, and is idle afterwards', async () => {
    const id = await sessionWithPhoto();
    api.changes = [{ kind: 'session_result', id, data: { sessionId: id, challengeId, verdict: 'verified', totalPoints: 42, completed: false, breakdown: [], flags: [], wellness: null } }];
    const r = await worker.runOnce();
    expect(r).toMatchObject({ outcome: 'ok', pushed: 3, uploaded: 1, pulled: 1 });
    expect(await worker.counts()).toEqual({ pendingEvents: 0, pendingPhotos: 0, pendingOutbox: 0, failed: 0, waitingForWifi: 0 });
    expect((await db.get<{ verdict: string }>('SELECT verdict FROM sessions WHERE id = ?', [id]))!.verdict).toBe('verified');
    const again = await worker.runOnce();
    expect(again.pushed).toBe(0);
    expect(api.pushes).toHaveLength(1);
    expect(await store.getMeta('pull_cursor')).toBe('1');
  });

  it('offline keeps everything pending and never marks in_flight permanently', async () => {
    await sessionWithPhoto();
    api.pushMode = 'offline';
    expect((await worker.runOnce()).outcome).toBe('offline');
    const st = await db.all<{ sync_state: string }>('SELECT DISTINCT sync_state FROM events');
    expect(st.map((s) => s.sync_state)).toEqual(['pending']);
  });

  it('non-retryable rejections go to the dead letter (visible as failed), retryables stay pending', async () => {
    await sessionWithPhoto();
    api.pushMode = 'retryable';
    await worker.runOnce();
    expect((await worker.counts()).failed).toBe(0);
    expect((await worker.counts()).pendingEvents).toBe(3);
    api.pushMode = 'reject_all';
    const r = await worker.runOnce();
    expect(r.outcome).toBe('partial');
    expect((await worker.counts()).failed).toBe(3);
    expect((await db.get<{ last_error: string }>('SELECT last_error FROM events LIMIT 1'))!.last_error).toMatch(/SCHEMA_INVALID/);
  });

  it('photos: never before their event is acked; conflict = permanent failure; 5xx/404 = backoff retry', async () => {
    await sessionWithPhoto();
    api.pushMode = 'offline';
    await worker.runOnce();
    expect(api.uploads).toHaveLength(0);
    api.pushMode = 'ack';
    api.uploadMode = 'server_error';
    await worker.runOnce();
    const ev = await db.get<{ upload_state: string; attempts: number; next_attempt_at: number }>('SELECT * FROM evidence');
    expect(ev).toMatchObject({ upload_state: 'pending', attempts: 1 });
    expect(ev!.next_attempt_at).toBe(now + backoffMs(1, () => 1));
    await worker.runOnce(); // still backing off → no new upload attempt
    expect(api.uploads).toHaveLength(1);
    now += 60_000;
    api.uploadMode = 'conflict';
    const r = await worker.runOnce();
    expect(r.uploadFailed).toBe(1);
    expect((await db.get<{ upload_state: string }>('SELECT upload_state FROM evidence'))!.upload_state).toBe('failed');
    await worker.retryFailed();
    api.uploadMode = 'ok';
    await worker.runOnce();
    expect((await db.get<{ upload_state: string }>('SELECT upload_state FROM evidence'))!.upload_state).toBe('uploaded');
  });

  it('respects "photos on Wi-Fi only"', async () => {
    await sessionWithPhoto();
    photosAllowed = false;
    await worker.runOnce();
    expect(api.uploads).toHaveLength(0);
    expect((await worker.counts()).waitingForWifi).toBe(1);
    expect(syncPill({ online: true, syncing: false, counts: await worker.counts(), lastReport: null, awaitingVerdict: 0 }).state).toBe('wifi');
  });

  it('outbox: Idempotency-Key = row id, retries on network errors, dead-letters 4xx', async () => {
    const id1 = await worker.enqueue('join', 'POST', '/v1/challenges/x/join', {});
    api.requestMode = 'offline';
    expect((await worker.runOnce()).outcome).toBe('offline');
    expect(api.requests[0]!.key).toBe(id1);
    now += 3_600_000;
    api.requestMode = 'ok';
    expect((await worker.runOnce()).outboxSent).toBe(1);
    expect(api.requests.at(-1)!.key).toBe(id1); // same key on retry
    await worker.enqueue('join', 'POST', '/v1/challenges/y/join', {});
    api.requestMode = 'bad_request';
    await worker.runOnce();
    expect((await worker.counts()).failed).toBe(1);
  });

  it('single-flight: concurrent runs share one execution', async () => {
    await sessionWithPhoto();
    const [a, b] = await Promise.all([worker.runOnce(), worker.runOnce()]);
    expect(a).toBe(b);
    expect(api.pushes).toHaveLength(1);
  });

  it('recovers items left in_flight by a killed run', async () => {
    await sessionWithPhoto();
    await db.run(`UPDATE events SET sync_state = 'in_flight'`);
    await db.run(`UPDATE evidence SET upload_state = 'uploading'`);
    const r = await worker.runOnce();
    expect(r.pushed).toBe(3);
    expect(r.uploaded).toBe(1);
  });

  it('prunes only acked events of finished, verified sessions', async () => {
    const id = await sessionWithPhoto();
    await worker.runOnce();
    await db.run('UPDATE sessions SET verdict = ? WHERE id = ?', ['verified', id]);
    now += 8 * 86_400_000;
    await db.run('UPDATE events SET acked_at = ?', [new Date(now - 8 * 86_400_000).toISOString()]);
    const active = await sm.start({ challengeId, version: 1, startFix: { lat: P.start[1], lng: P.start[0], acc: 5, ts: new Date().toISOString() } });
    await worker.prune();
    expect((await db.get<{ n: number }>('SELECT count(*) AS n FROM events WHERE session_id = ?', [id]))!.n).toBe(0);
    expect((await db.get<{ n: number }>('SELECT count(*) AS n FROM events WHERE session_id = ?', [active]))!.n).toBe(1); // unacked never pruned
  });
});

describe('backoff', () => {
  it('is exponential with full jitter and capped', () => {
    expect(backoffMs(1, () => 1)).toBe(2000);
    expect(backoffMs(3, () => 1)).toBe(8000);
    expect(backoffMs(30, () => 1)).toBe(15 * 60_000);
    expect(backoffMs(5, () => 0)).toBe(0);
  });
});

describe('ApiClient', () => {
  const device = { id: uuidv7(), platform: 'test' as const, appVersion: '1' };
  it('refreshes once for concurrent 401s (single-flight) and retries the request', async () => {
    let refreshes = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization;
      if (url.endsWith('/v1/auth/refresh')) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 10));
        return new Response(JSON.stringify({ user: {}, accessToken: 'new', refreshToken: 'r2'.padEnd(30, 'x'), expiresIn: 900 }), { status: 200 });
      }
      if (auth !== 'Bearer new') return new Response(JSON.stringify({ code: 'TOKEN_EXPIRED' }), { status: 401 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const tokens = memoryTokens();
    tokens.tokens = { accessToken: 'old', refreshToken: 'r1'.padEnd(30, 'x') };
    const api = new ApiClient({ baseUrl: 'http://x', tokens, device, fetchImpl });
    const results = await Promise.all([api.request('GET', '/a'), api.request('GET', '/b'), api.request('GET', '/c')]);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(refreshes).toBe(1);
    expect(tokens.tokens.accessToken).toBe('new');
  });

  it('clears tokens and raises AuthRequiredError when refresh is rejected', async () => {
    let lost = false;
    const fetchImpl = (async () => new Response(JSON.stringify({ code: 'TOKEN_REUSED' }), { status: 401 })) as unknown as typeof fetch;
    const tokens = memoryTokens();
    tokens.tokens = { accessToken: 'old', refreshToken: 'r'.repeat(30) };
    const api = new ApiClient({ baseUrl: 'http://x', tokens, device, fetchImpl, onAuthLost: () => (lost = true) });
    await expect(api.request('GET', '/a')).rejects.toBeInstanceOf(AuthRequiredError);
    expect(tokens.tokens.refreshToken).toBeNull();
    expect(lost).toBe(true);
  });

  it('maps problem+json and network failures', async () => {
    const tokens = memoryTokens();
    tokens.tokens = { accessToken: 'a', refreshToken: 'r'.repeat(30) };
    const api409 = new ApiClient({ baseUrl: 'http://x', tokens, device, fetchImpl: (async () => new Response(JSON.stringify({ code: 'CHALLENGE_FULL', detail: 'full' }), { status: 409 })) as never });
    const e = await api409.request('POST', '/j').catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('CHALLENGE_FULL');
    expect(e.retryable).toBe(false);
    const apiDown = new ApiClient({ baseUrl: 'http://x', tokens, device, fetchImpl: (async () => { throw new TypeError('fail'); }) as never });
    await expect(apiDown.request('GET', '/x')).rejects.toBeInstanceOf(NetworkError);
  });

  it('rounds discovery location to ~1 km before it leaves the device', async () => {
    let seen = '';
    const tokens = memoryTokens();
    tokens.tokens = { accessToken: 'a', refreshToken: 'r'.repeat(30) };
    const api = new ApiClient({ baseUrl: 'http://x', tokens, device, fetchImpl: (async (url: string) => { seen = url; return new Response('{"items":[],"nextCursor":null}'); }) as never });
    await api.listChallenges({ near: [88.3512345, 22.5119876] });
    expect(seen).toContain('near=22.51%2C88.35');
  });
});

describe('SessionManager edge cases', () => {
  const fix = () => ({ lat: P.start[1], lng: P.start[0], acc: 5, ts: new Date().toISOString() });
  it('refuses to start without a downloaded bundle', async () => {
    await expect(sm.start({ challengeId: uuidv7(), version: 1, startFix: fix() })).rejects.toThrow(/not downloaded/);
  });
  it('flushes GPS by count (30) and keeps causal order before other events', async () => {
    const id = await sm.start({ challengeId, version: 1, startFix: fix() });
    const base = Date.now();
    await sm.addFixes(id, Array.from({ length: 29 }, (_, i) => ({ lat: P.start[1], lng: P.start[0], acc: 5, timestamp: base + i * 1000 })));
    expect((await sm.events(id)).filter((e) => e.type === 'LocationBatch')).toHaveLength(0);
    await sm.addFixes(id, [{ lat: P.start[1], lng: P.start[0], acc: 5, timestamp: base + 30_000 }]);
    expect((await sm.events(id)).filter((e) => e.type === 'LocationBatch')).toHaveLength(1);
    await sm.addFixes(id, [{ lat: P.start[1], lng: P.start[0], acc: 5, timestamp: base + 31_000 }]);
    await sm.append(id, 'TaskStarted', { taskId: 'litter' });
    const types = (await sm.events(id)).map((e) => e.type);
    expect(types.slice(-2)).toEqual(['LocationBatch', 'TaskStarted']);
  });
  it('abandon ends the session, clears the active pointer, and is scored as not completed', async () => {
    const id = await sm.start({ challengeId, version: 1, startFix: fix() });
    await sm.abandon(id, 'rain');
    expect(await sm.activeSessionId()).toBeNull();
    const snap = await sm.snapshot(id);
    expect(snap.state.status).toBe('abandoned');
    expect(snap.score.completed).toBe(false);
  });
  it('impact sums trees, litter and distance from finished sessions', async () => {
    expect(await sm.impact()).toEqual({ sessions: 0, trees: 0, litter: 0, distanceM: 0, steps: 0 });
  });
});

describe('sync status presentation', () => {
  const counts = { pendingEvents: 0, pendingPhotos: 0, pendingOutbox: 0, failed: 0, waitingForWifi: 0 };
  it.each([
    [{ online: true, syncing: false, counts, lastReport: { outcome: 'auth_required' } as never, awaitingVerdict: 0 }, 'auth'],
    [{ online: true, syncing: true, counts: { ...counts, pendingPhotos: 3 }, lastReport: null, awaitingVerdict: 0 }, 'syncing'],
    [{ online: true, syncing: false, counts: { ...counts, pendingOutbox: 1 }, lastReport: null, awaitingVerdict: 0 }, 'ready'],
    [{ online: true, syncing: false, counts, lastReport: null, awaitingVerdict: 2 }, 'validating'],
  ])('%# → %s', (input, state) => {
    expect(syncPill(input).state).toBe(state);
  });
  it('relative time', () => {
    const n = Date.parse('2026-10-09T10:00:00Z');
    expect(relativeTime(null, n)).toBe('never');
    expect(relativeTime('2026-10-09T09:59:30Z', n)).toBe('just now');
    expect(relativeTime('2026-10-09T09:58:00Z', n)).toBe('2 min ago');
    expect(relativeTime('2026-10-09T07:00:00Z', n)).toBe('3 h ago');
  });
});
