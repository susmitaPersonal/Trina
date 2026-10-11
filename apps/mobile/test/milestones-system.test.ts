/**
 * SYSTEM TESTS for milestones + custom modules: N phone cores (own SQLite, keys, clocks, sync
 * workers) ⇄ the real Trina server (in-process HTTP).
 *  1. AI module → publish → challenge → join → download → play OFFLINE with a QR handshake →
 *     provisional unlocks offline → sync → the server agrees with the phone.
 *  2. Offline Daily Quest: the QuestGuard blocks every network call while the quest runs.
 *  3. Chaos (property): random network failures still give exactly-once unlocks and notifications.
 */
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import { TemplateProvider } from '@trina/ai';
import { uuidv7, type DeviceKeyPair } from '@trina/contracts';
import { challengeFromModule, compileModuleOrThrow, DAILY_QUEST_CHALLENGE_ID } from '@trina/engine';
import { DEMO_CENTER } from '@trina/engine/fixtures';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createContext } from '../../server/src/app';
import { testConfig } from '../../server/src/config';
import type { AppContext } from '../../server/src/platform/context';
import { ApiClient, QuestBlockedError } from '../src/core/api-client';
import { ConfirmationService, type KeyStore } from '../src/core/confirmations';
import { MilestoneService } from '../src/core/milestones';
import { migrateLocal } from '../src/core/migrations';
import { OfflineStore } from '../src/core/offline-store';
import { SessionManager } from '../src/core/session-manager';
import { SyncWorker } from '../src/core/sync-worker';
import { FakeClock, flakyFetch, fsUploader, memoryTokens, stay } from './helpers';
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

const memoryKeys = (): KeyStore => {
  let k: DeviceKeyPair | null = null;
  return { get: async () => k, set: async (x) => void (k = x) };
};

/** A phone: own SQLite, token store, device key, clock, quest guard, milestone service and sync worker. */
async function newPhone(name: string) {
  const db = nodeSqlite();
  await migrateLocal(db);
  const net = flakyFetch();
  const device = { id: uuidv7(), platform: 'test' as const, appVersion: '0.1.0' };
  const guard = { quest: false, calls: 0 };
  const counting = (async (url: string | URL | Request, init?: RequestInit) => {
    guard.calls++;
    return net.fetch(url, init);
  }) as typeof fetch;
  const api = new ApiClient({ baseUrl, tokens: memoryTokens(), device, fetchImpl: counting, uploader: fsUploader(counting), blocked: () => guard.quest });
  const auth = await api.register({ email: `${name}-${uuidv7()}@t.dev`, password: 'correct horse battery', displayName: name });
  const store = new OfflineStore(db);
  const clock = new FakeClock(Date.now() - 3 * 3_600_000);
  const milestones = new MilestoneService(db, store, { userId: auth.user.id });
  const sm = new SessionManager(db, store, clock, { userId: auth.user.id, deviceId: device.id }, { milestones, tzOffsetMin: () => 330 });
  const sync = new SyncWorker({ db, api, store, deviceId: device.id, random: () => 0, milestones });
  const confirm = new ConfirmationService(db, sm, memoryKeys(), { userId: auth.user.id, deviceId: device.id, displayName: name }, () => clock.wallNow());
  return { name, db, api, auth, store, clock, sm, sync, confirm, milestones, net, guard };
}
type Phone = Awaited<ReturnType<typeof newPhone>>;

async function syncUntilIdle(p: Phone, max = 30) {
  for (let i = 0; i < max; i++) {
    await p.sync.runOnce();
    const c = await p.sync.counts();
    if (c.pendingEvents + c.pendingPhotos + c.pendingOutbox === 0) return;
    await p.db.run('UPDATE evidence SET next_attempt_at = 0');
    await p.db.run('UPDATE outbox SET next_attempt_at = 0');
  }
  throw new Error(`${p.name} did not reach idle`);
}

/** The app's notification logic (app/milestone-notify.ts) reduced to counters: each unlock once, each confirmation once. */
async function notifyCycle(p: Phone, seen: Map<string, number>, confirmed: Map<string, number>) {
  const fresh = await p.milestones.evaluateLocal();
  for (const m of fresh) seen.set(`${m.key}|${m.windowKey}|${m.tier}`, (seen.get(`${m.key}|${m.windowKey}|${m.tier}`) ?? 0) + 1);
  await p.milestones.markNotified(fresh);
  const fin = await p.milestones.newlyFinal();
  for (const m of fin) {
    const id = `${m.key}|${m.windowKey}|${m.tier}`;
    if (seen.has(id)) confirmed.set(id, (confirmed.get(id) ?? 0) + 1);
    else seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  await p.milestones.markFinalNotified(fin);
}

const serverKeys = async (p: Phone) =>
  new Set((await ctx.db.query<{ milestone_key: string; window_key: string; tier: string }>(`SELECT milestone_key, window_key, tier FROM user_milestones WHERE user_id = $1 AND status = 'final'`, [p.auth.user.id])).map((r) => `${r.milestone_key}|${r.window_key}|${r.tier}`));
const localKeys = async (p: Phone, status: string[] = ['final']) => new Set((await p.milestones.all(status as never)).map((m) => `${m.key}|${m.windowKey}|${m.tier}`));

describe('custom module: AI → publish → join → offline play with a QR handshake → sync → server agrees', () => {
  it('runs the whole Hacktoberfest story for kite flying', async () => {
    // 1. Organizer drafts a module with the AI (model offline → templates), saves and publishes it.
    const org = await newPhone('Priya');
    const draft = await org.api.moduleDraft('kite flying with friends in the field on Sunday afternoon');
    expect(draft.status).toBe('ok');
    const mod = await org.api.createModule(draft.definition, uuidv7(), draft.generationId);
    await org.api.publishModule(mod.id, 1, 'unlisted');
    const def = challengeFromModule(compileModuleOrThrow(mod.definition), { start: DEMO_CENTER, durationMin: 60, difficulty: 'medium', team: false });
    const created = await org.api.createChallenge(def, uuidv7());
    await org.api.publish(created.id, 1);

    // 2. Two friends join, register device keys, download the bundle (module + keys travel with it).
    const [a, b] = [await newPhone('Arjun'), await newPhone('Meera')];
    for (const p of [a, b]) {
      await p.api.registerDeviceKey((await p.confirm.ensureKeys()).publicKeyHex);
      await p.api.join(created.id, {});
    }
    for (const p of [a, b]) await p.store.saveBundle(await p.api.bundle(created.id, 1), Date.now());
    const bundle = (await a.store.getChallenge(created.id))!.bundle;
    expect(bundle.modules.map((m) => m.id)).toEqual([mod.id]);
    expect(bundle.participantKeys).toHaveLength(2);

    // 3. OFFLINE: both play at the field; Meera confirms Arjun's duel win by QR, phone to phone.
    for (const p of [a, b]) p.net.ctl.online = false;
    const callsBefore = a.guard.calls + b.guard.calls;
    const fix = { lat: DEMO_CENTER[1], lng: DEMO_CENTER[0], acc: 6, ts: new Date(a.clock.wallNow()).toISOString() };
    const sa = await a.sm.start({ challengeId: created.id, version: 1, startFix: fix });
    const sb = await b.sm.start({ challengeId: created.id, version: 1, startFix: { ...fix, ts: new Date(b.clock.wallNow()).toISOString() } });
    await stay(a.sm, sa, a.clock, DEMO_CENTER, 35 * 60, 10);
    await stay(b.sm, sb, b.clock, DEMO_CENTER, 35 * 60, 10);
    const counter = `${mod.id}.${mod.definition && (mod.definition as any).counters[0].id}`;
    await a.sm.reportCount(sa, counter, 1);
    const qrA = await a.confirm.request(sa, [{ kind: 'counter', ref: counter, value: 1 }]);
    const { qr: qrB } = await b.confirm.approve(qrA, sb);
    const accepted = await a.confirm.accept(qrB, sa, bundle.participantKeys);
    expect(accepted.keyChecked).toBe(true);
    await expect(a.confirm.accept(qrB.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), sa, bundle.participantKeys)).rejects.toThrow();
    const fa = await a.sm.finish(sa, 'manual', { shareWellbeing: false });
    await b.sm.finish(sb, 'manual', { shareWellbeing: false });
    expect(a.guard.calls + b.guard.calls).toBe(callsBefore); // nothing touched the network
    // Unlocked OFFLINE (provisional), right after the session.
    const offlineUnlocks = fa.unlocks.map((u) => `${u.key}|${u.tier}`);
    expect(offlineUnlocks).toEqual(expect.arrayContaining([`${mod.id}@1:in_the_field|bronze`, '*@1:outdoor_minutes|bronze']));
    expect(fa.unlocks.every((u) => u.status === 'provisional')).toBe(true);
    expect(fa.score.facts[`${counter}.confirmed`]).toBe(1);

    // 4. Back online: Arjun syncs first (confirmation pending), then Meera; the server re-validates.
    for (const p of [a, b]) p.net.ctl.online = true;
    await syncUntilIdle(a);
    await ctx.jobs.drain();
    await syncUntilIdle(b);
    await ctx.jobs.drain();
    for (const p of [a, b]) await p.sync.runOnce();

    const ra = await a.api.session(sa);
    expect(ra.verdict).toBe('verified');
    expect(ra.score!.totalPoints).toBe(fa.score.total); // device == server, including the confirmed duel
    // Server milestones == phone milestones (final), exactly once.
    expect(await localKeys(a)).toEqual(await serverKeys(a));
    expect((await a.milestones.all(['final'])).some((m) => m.key === `${mod.id}@1:in_the_field` && m.tier === 'bronze' && m.label === 'Measured')).toBe(true);
    const progress = await a.api.myProgress();
    expect(progress.xp).toBeGreaterThan(0);
    expect((await a.milestones.progress()).server?.xp).toBe(progress.xp);
  });
});

describe('offline Daily Quest with the QuestGuard', () => {
  it('blocks every request during the quest, unlocks offline, and the server agrees after sync', async () => {
    const p = await newPhone('Quester');
    const fix = { lat: DEMO_CENTER[1], lng: DEMO_CENTER[0], acc: 6, ts: new Date(p.clock.wallNow()).toISOString() };
    await expect(p.sm.startQuest({ spec: { templateId: 'outside_v1', targetMinutes: 30, levelTier: 'easy' }, startFix: fix, online: true })).rejects.toThrow(/Turn off/);
    const sid = await p.sm.startQuest({ spec: { templateId: 'outside_v1', targetMinutes: 30, levelTier: 'easy' }, startFix: fix, online: false });
    p.guard.quest = (await p.sm.activeQuestId()) === sid;
    const calls = p.guard.calls;
    await expect(p.api.myProgress()).rejects.toBeInstanceOf(QuestBlockedError);
    expect((await p.sync.runOnce()).outcome).toBe('offline');
    await stay(p.sm, sid, p.clock, DEMO_CENTER, 31 * 60, 15);
    const done = await p.sm.finish(sid, 'rules', { shareWellbeing: false });
    p.guard.quest = (await p.sm.activeQuestId()) !== null;
    expect(p.guard.calls).toBe(calls); // not a single request while the quest ran
    expect(done.challenge.id).toBe(DAILY_QUEST_CHALLENGE_ID);
    expect(done.unlocks.map((u) => u.key)).toEqual(expect.arrayContaining(['*@1:q_offline_30', '*@1:l_first_offline']));

    await syncUntilIdle(p);
    await ctx.jobs.drain();
    await p.sync.runOnce();
    expect((await p.api.session(sid)).verdict).toBe('verified');
    expect(await localKeys(p)).toEqual(await serverKeys(p));
    expect((await p.milestones.all(['provisional'])).length).toBe(0);
    const dq = await p.milestones.dailyQuests();
    expect(dq.quests).toHaveLength(3);
    // The phone picks the same Daily Quests offline as the server does for that day.
    const serverQuests = await p.api.request<{ quests: Array<{ key: string }> }>('GET', `/v1/me/quests?date=${dq.dayKey}`);
    expect(dq.quests.map((q) => q.key)).toEqual(serverQuests.quests.map((q) => q.key));
  });
});

describe('chaos: random network failures give exactly-once unlocks and notifications (property)', () => {
  it('eventually agrees with the server; each unlock is announced once and confirmed once', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom('ok', 'ok', 'offline', 'drop'), { minLength: 4, maxLength: 16 }), async (schedule) => {
        const p = await newPhone('Chaos');
        const seen = new Map<string, number>();
        const confirmed = new Map<string, number>();
        const fix = { lat: DEMO_CENTER[1], lng: DEMO_CENTER[0], acc: 6, ts: new Date(p.clock.wallNow()).toISOString() };
        const sid = await p.sm.startQuest({ spec: { templateId: 'outside_v1', targetMinutes: 30, levelTier: 'easy' }, startFix: fix, online: false });
        await stay(p.sm, sid, p.clock, DEMO_CENTER, 32 * 60, 20);
        await p.sm.finish(sid, 'rules', { shareWellbeing: false });
        await notifyCycle(p, seen, confirmed);
        for (const step of schedule) {
          p.net.ctl.online = step !== 'offline';
          p.net.ctl.dropNextResponse = step === 'drop';
          await p.sync.runOnce();
          await ctx.jobs.drain();
          await notifyCycle(p, seen, confirmed);
        }
        p.net.ctl.online = true;
        p.net.ctl.dropNextResponse = false;
        await syncUntilIdle(p);
        await ctx.jobs.drain();
        await p.sync.runOnce();
        await notifyCycle(p, seen, confirmed);
        expect(await localKeys(p)).toEqual(await serverKeys(p));
        for (const n of seen.values()) expect(n).toBe(1);
        for (const n of confirmed.values()) expect(n).toBe(1);
        const dup = await ctx.db.one<{ n: string }>(`SELECT count(*) AS n FROM (SELECT milestone_key, window_key, tier, count(*) c FROM user_milestones WHERE user_id = $1 GROUP BY 1,2,3 HAVING count(*) > 1) x`, [p.auth.user.id]);
        expect(Number(dup!.n)).toBe(0);
      }),
      { numRuns: 5 },
    );
  });
});
