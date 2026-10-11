/**
 * Verification pass 5: phone ↔ server milestone reconciliation edge cases
 * (truncated server list, reconcile interrupted by the network, rejected sessions in provisional views).
 */
import { uuidv7 } from '@trina/contracts';
import { DEMO_CENTER } from '@trina/engine/fixtures';
import { describe, expect, it } from 'vitest';
import { NetworkError } from '../src/core/api-client';
import { MilestoneService } from '../src/core/milestones';
import { migrateLocal } from '../src/core/migrations';
import { OfflineStore } from '../src/core/offline-store';
import { SessionManager } from '../src/core/session-manager';
import { SyncWorker } from '../src/core/sync-worker';
import { FakeClock, stay } from './helpers';
import { nodeSqlite } from './node-sqlite';

type Item = Parameters<MilestoneService['reconcile']>[0][number];

async function phone() {
  const db = nodeSqlite();
  await migrateLocal(db);
  const store = new OfflineStore(db);
  const clock = new FakeClock(Date.parse('2026-10-12T02:00:00Z'));
  const userId = uuidv7();
  const milestones = new MilestoneService(db, store, { userId, now: () => clock.wallNow() });
  const sm = new SessionManager(db, store, clock, { userId, deviceId: uuidv7() }, { milestones, tzOffsetMin: () => 330 });
  return { db, store, clock, milestones, sm };
}

const spec = { templateId: 'outside_v1', targetMinutes: 30 as const, levelTier: 'easy' as const };
const fix = (c: FakeClock) => ({ lat: DEMO_CENTER[1], lng: DEMO_CENTER[0], acc: 6, ts: new Date(c.wallNow()).toISOString() });

const item = (i: number, at: string): Item => ({
  key: `*@1:m_${i}`, windowKey: '2026-10-01', tier: 'unlock', title: `M${i}`, value: 1, verification: 'sensor', stat: 'VIT', dayKey: '2026-10-01', unlockedAt: at,
});

describe('reconcile with a truncated server list (GET /v1/me/milestones returns at most 500 rows)', () => {
  it('keeps older final rows that fell off the list, and revokes only what the server says', async () => {
    const p = await phone();
    // An older final unlock the phone already knows about.
    await p.milestones.reconcile([item(9999, '2026-09-01T10:00:00.000Z')]);
    expect((await p.milestones.all()).find((m) => m.key === '*@1:m_9999')!.status).toBe('final');

    // Months later the server list is full (500 newest rows) and no longer includes it.
    const full = Array.from({ length: 500 }, (_, i) => item(i, '2026-10-01T10:00:00.000Z'));
    await p.milestones.reconcile(full);
    expect((await p.milestones.all()).find((m) => m.key === '*@1:m_9999')!.status).toBe('final');

    // An explicit revocation from the pull change still revokes it.
    await p.milestones.reconcile(full, ['*@1:m_9999|2026-10-01|unlock']);
    expect((await p.milestones.all()).find((m) => m.key === '*@1:m_9999')!.status).toBe('revoked');
  });
});

describe('reconcile interrupted by the network', () => {
  it('runs again on the next sync even though the milestones change was already pulled', async () => {
    const p = await phone();
    const sid = await p.sm.startQuest({ spec, startFix: fix(p.clock), online: false });
    await stay(p.sm, sid, p.clock, DEMO_CENTER, 31 * 60, 20);
    const done = await p.sm.finish(sid, 'rules', { shareWellbeing: false });
    const day = done.unlocks[0]!.dayKey;
    const serverItem: Item = { key: '*@1:q_offline_30', windowKey: day, tier: 'unlock', title: 'x', value: 1, verification: 'sensor', stat: 'VIT', dayKey: day, unlockedAt: null };

    let listOffline = true;
    let served = false;
    const api = {
      push: async (b: { batchId: string; sessions: Array<{ sessionId: string; events: Array<{ seq: number }> }> }) => {
        const s = b.sessions[0]!;
        const seqs = s.events.map((e) => e.seq);
        return { batchId: b.batchId, serverTime: new Date().toISOString(), results: [{ sessionId: s.sessionId, ackedThroughSeq: Math.max(...seqs), accepted: seqs.length, duplicates: 0, rejected: [], missingSeqs: [], evidenceNeeded: [] }] };
      },
      uploadEvidence: async () => 'uploaded' as const,
      pull: async (cursor: string) => {
        const changes = cursor === '0' && !served ? [{ kind: 'milestones', id: uuidv7(), data: { items: [serverItem], revokedKeys: [] } }] : [];
        served ||= changes.length > 0;
        return { changes, cursor: changes.length ? '1' : cursor, serverTime: new Date().toISOString() };
      },
      request: async (_m: string, path: string) => {
        if (path.startsWith('/v1/me/milestones')) {
          if (listOffline) throw new NetworkError();
          return { items: [serverItem] };
        }
        return undefined;
      },
    };
    const worker = new SyncWorker({ db: p.db, api: api as never, store: p.store, deviceId: uuidv7(), milestones: p.milestones, now: () => p.clock.wallNow(), random: () => 1 });

    expect((await worker.runOnce()).outcome).toBe('offline'); // the list request failed after the cursor moved
    expect((await p.milestones.all()).find((m) => m.key === '*@1:q_offline_30')!.status).toBe('provisional');

    listOffline = false;
    await worker.runOnce();
    expect((await p.milestones.all()).find((m) => m.key === '*@1:q_offline_30')!.status).toBe('final');
  });
});

describe('provisional views after the server rejects a session', () => {
  it('a rejected session no longer counts toward provisional minutes, weeks or daily quests', async () => {
    const p = await phone();
    const sid = await p.sm.startQuest({ spec, startFix: fix(p.clock), online: false });
    await stay(p.sm, sid, p.clock, DEMO_CENTER, 31 * 60, 20);
    await p.sm.finish(sid, 'rules', { shareWellbeing: false });

    const before = (await p.milestones.progress()).provisional;
    expect(before.verifiedOutdoorMinutes).toBeGreaterThanOrEqual(30);

    await p.milestones.markSummaryFinal(sid, false); // server verdict: rejected
    const after = (await p.milestones.progress()).provisional;
    expect(after.verifiedOutdoorMinutes).toBe(0);
    expect(after.offlineQuestMinutes).toBe(0);
    const dq = await p.milestones.dailyQuests();
    expect(dq.quests.every((q) => q.value === 0)).toBe(true);
  });
});

describe('confirmation claims can not be duplicated (each counter or task once)', () => {
  it('a QR-A or signed body that repeats a claim is refused, and lowerOnly never emits a ref twice', async () => {
    const { ConfirmationRequest, ConfirmationBody, lowerOnly } = await import('@trina/contracts');
    const c = { kind: 'counter' as const, ref: 'cricket.balls_faced', value: 30 };
    const base = { t: 'req' as const, challengeId: uuidv7(), subjectUserId: uuidv7(), subjectSessionId: uuidv7(), subjectName: 'A' };
    expect(ConfirmationRequest.safeParse({ ...base, claims: [c, c] }).success).toBe(false);
    expect(ConfirmationRequest.safeParse({ ...base, claims: [c] }).success).toBe(true);
    expect(ConfirmationBody.safeParse({ confirmationId: uuidv7(), challengeId: uuidv7(), subjectUserId: uuidv7(), subjectSessionId: uuidv7(), issuerUserId: uuidv7(), issuerDeviceId: uuidv7(), role: 'peer', claims: [c, { ...c, value: 5 }] }).success).toBe(false);
    expect(lowerOnly([c], [c, { ...c, value: 10 }])).toEqual([{ ...c, value: 30 }]);
  });
});

describe('confirmation handshake with many claims (QR size)', () => {
  it('a 6-claim confirmation with long names is signed, scanned and recorded on both phones', async () => {
    const { ConfirmationService } = await import('../src/core/confirmations');
    const mk = async (name: string) => {
      const p = await phone();
      let k: any = null;
      const userId = (p.sm as any).ids.userId as string;
      const confirm = new ConfirmationService(p.db, p.sm, { get: async () => k, set: async (x) => void (k = x) }, { userId, deviceId: uuidv7(), displayName: name }, () => p.clock.wallNow());
      const sid = await p.sm.startQuest({ spec, startFix: fix(p.clock), online: false });
      return { ...p, confirm, sid };
    };
    const a = await mk('অর্জুন চক্রবর্তী'.padEnd(40, 'অ'));
    const b = await mk('मीरा'.repeat(10));
    // Both phones play the same challenge id (the daily quest); six distinct counters.
    const claims = ['catches', 'runs', 'balls_faced', 'wickets', 'boundaries', 'sixes'].map((c, i) => ({ kind: 'counter' as const, ref: `cricket.${c}`, value: 100 + i }));
    const qrA = await a.confirm.request(a.sid, claims);
    expect(qrA.length).toBeLessThanOrEqual(1024);
    const { qr: qrB } = await b.confirm.approve(qrA, b.sid);
    expect(qrB.length).toBeLessThanOrEqual(1024);
    const got = await a.confirm.accept(qrB, a.sid);
    expect(got.claims).toEqual(claims);
    expect((await b.sm.events(b.sid)).filter((e) => e.type === 'ConfirmationIssued')).toHaveLength(1);
    expect((await a.sm.events(a.sid)).filter((e) => e.type === 'ConfirmationReceived')).toHaveLength(1);
  });
});

describe('a second account on the same phone', () => {
  it("sees only its own sessions, summaries and milestones; per-user caches reset; unsynced data is kept", async () => {
    const p = await phone();
    const a = (p.sm as any).ids.userId as string;
    const sid = await p.sm.startQuest({ spec, startFix: fix(p.clock), online: false });
    await stay(p.sm, sid, p.clock, DEMO_CENTER, 31 * 60, 20);
    await p.sm.finish(sid, 'rules', { shareWellbeing: false });
    await p.milestones.markNotified(await p.milestones.evaluateLocal());
    expect((await p.milestones.all()).length).toBeGreaterThan(0);
    expect(await p.store.onSignIn(a)).toBe(false); // first sign-in of A: nothing to reset
    await p.store.setMeta('pull_cursor', '42');
    await p.store.setMeta('device_key_registered', '1');
    await p.db.run(`INSERT INTO cache_guilds (id, json, fetched_at) VALUES ('g', '{}', 'x')`);

    const b = uuidv7();
    expect(await p.store.onSignIn(b)).toBe(true);
    const msB = new MilestoneService(p.db, p.store, { userId: b, now: () => p.clock.wallNow() });
    const smB = new SessionManager(p.db, p.store, p.clock, { userId: b, deviceId: uuidv7() }, { milestones: msB });
    expect(await msB.summaries()).toEqual([]);
    expect(await msB.all()).toEqual([]);
    expect(await msB.evaluateLocal()).toEqual([]); // A's sessions never unlock anything for B
    expect((await msB.progress()).provisional.verifiedOutdoorMinutes).toBe(0);
    expect(await smB.history()).toEqual([]);
    expect((await smB.impact()).sessions).toBe(0);
    expect(await p.store.getMeta('pull_cursor')).toBeNull();
    expect(await p.store.getMeta('device_key_registered')).toBeNull(); // B registers its own key
    expect(await p.db.all('SELECT * FROM cache_guilds')).toEqual([]);
    // A's unsynced events stay on the phone (rule 5).
    expect(Number((await p.db.get<{ n: number }>(`SELECT count(*) AS n FROM events WHERE session_id = ?`, [sid]))!.n)).toBeGreaterThan(0);
    // A signs back in: A's own history and milestones come back (re-derived locally).
    expect(await p.store.onSignIn(a)).toBe(true);
    expect((await p.sm.history()).map((h) => h.id)).toEqual([sid]);
    expect((await p.milestones.evaluateLocal()).length).toBeGreaterThan(0);
  });
});

describe("sync never sends another account's data", () => {
  it("A's unsynced events and photos wait on the phone while B is signed in, then sync for A", async () => {
    const p = await phone();
    const a = (p.sm as any).ids.userId as string;
    const sid = await p.sm.startQuest({ spec, startFix: fix(p.clock), online: false });
    await stay(p.sm, sid, p.clock, DEMO_CENTER, 5 * 60, 20);
    await p.sm.captureEvidence({ sessionId: sid, taskId: 'proof', checkpointId: null, fileUri: '/tmp/x.jpg', sha256: 'a'.repeat(64), bytes: 10, fix: null }).catch(() => undefined);
    await p.sm.finish(sid, 'manual', { shareWellbeing: false });
    let signedIn = uuidv7(); // B
    const pushed: string[] = [];
    const api = {
      push: async (b: { batchId: string; sessions: Array<{ sessionId: string; events: Array<{ seq: number }> }> }) => {
        const s = b.sessions[0]!;
        pushed.push(s.sessionId);
        const seqs = s.events.map((e) => e.seq);
        return { batchId: b.batchId, serverTime: new Date().toISOString(), results: [{ sessionId: s.sessionId, ackedThroughSeq: Math.max(...seqs), accepted: seqs.length, duplicates: 0, rejected: [], missingSeqs: [], evidenceNeeded: [] }] };
      },
      uploadEvidence: async () => 'uploaded' as const,
      pull: async (cursor: string) => ({ changes: [], cursor, serverTime: new Date().toISOString() }),
      request: async () => undefined,
    };
    const worker = new SyncWorker({ db: p.db, api: api as never, store: p.store, deviceId: uuidv7(), userId: () => signedIn, now: () => p.clock.wallNow(), random: () => 1 });
    const asB = await worker.runOnce();
    expect(pushed).toEqual([]);
    expect(asB.pushed).toBe(0);
    expect((await worker.counts()).pendingEvents).toBe(0); // B's sync pill doesn't show A's queue
    signedIn = a;
    expect((await worker.counts()).pendingEvents).toBeGreaterThan(0);
    const asA = await worker.runOnce();
    expect(pushed).toEqual([sid]);
    expect(asA.pushed).toBeGreaterThan(0);
  });
});
