/**
 * SYSTEM TESTS for Offline Party Mode (ADR-032–034): N phone cores (own SQLite, keys, clocks, sync
 * workers) ⇄ the real Trina server (in-process HTTP). Phones talk to each other ONLY through the QR
 * strings the screens would show and scan.
 *  1. Host invites, members verify (same check words), everyone plays offline with zero network calls,
 *     meets by QR, gossips progress, finishes, syncs → every session verified, the server's goal matches.
 *  2. Every way a scan can go wrong is refused on the phone, and nothing is written to the chain.
 */
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import { TemplateProvider } from '@trina/ai';
import { decodePartyQr, uuidv7, type DeviceKeyPair, type Fix, type PartySpec } from '@trina/contracts';
import { destinationPoint, PARTY_CHALLENGE_ID } from '@trina/engine';
import { DEMO_CENTER } from '@trina/engine/fixtures';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createContext } from '../../server/src/app';
import { testConfig } from '../../server/src/config';
import type { AppContext } from '../../server/src/platform/context';
import { ApiClient, QuestBlockedError } from '../src/core/api-client';
import type { KeyStore } from '../src/core/confirmations';
import { MilestoneService } from '../src/core/milestones';
import { migrateLocal } from '../src/core/migrations';
import { OfflineStore } from '../src/core/offline-store';
import { PartyError, PartyService } from '../src/core/party';
import { SessionManager } from '../src/core/session-manager';
import { SyncWorker } from '../src/core/sync-worker';
import { FakeClock, flakyFetch, fsUploader, memoryTokens, stay, tmp, writePhoto } from './helpers';
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

async function newPhone(name: string, startWall = Date.now() - 3 * 3_600_000) {
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
  const clock = new FakeClock(startWall);
  const milestones = new MilestoneService(db, store, { userId: auth.user.id });
  const sm = new SessionManager(db, store, clock, { userId: auth.user.id, deviceId: device.id }, { milestones, tzOffsetMin: () => 330 });
  const sync = new SyncWorker({ db, api, store, deviceId: device.id, random: () => 0, milestones });
  const keys = memoryKeys();
  const party = new PartyService(db, sm, keys, { userId: auth.user.id, deviceId: device.id, displayName: name }, () => clock.wallNow());
  // Online, before the party: create and register the device key (the app does this at sign-in).
  const k = (await keys.get()) ?? (await (async () => {
    const { generateDeviceKeyPair } = await import('@trina/contracts');
    const x = generateDeviceKeyPair();
    await keys.set(x);
    return x;
  })());
  await api.registerDeviceKey(k.publicKeyHex);
  return { name, db, api, auth, store, clock, sm, sync, party, guard };
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

const fixAt = (p: Phone, at = DEMO_CENTER, acc = 6): Fix => ({ lat: at[1], lng: at[0], acc, ts: new Date(p.clock.wallNow()).toISOString() });
const SPEC: PartySpec = { v: 1, templateId: 'party_cleanup_v1', targetMinutes: 30, levelTier: 'medium', themeId: 'litter_hunters' };

/** One meeting by QR, exactly as two screens would do it: A shows, B scans + shows back, A scans. */
async function meet(a: Phone, aSid: string, b: Phone, bSid: string, kind: 'join' | 'checkpoint' | 'wrapup') {
  const offer = await a.party.offer(aSid);
  const answer = await b.party.scan(bSid, decodePartyQr(offer), kind);
  if (answer.kind !== 'answer') throw new Error('expected an answer');
  const done = await a.party.scan(aSid, decodePartyQr(answer.frames), kind);
  expect(done).toEqual({ kind: 'recorded', peerName: b.name });
}

/** One phone shows its progress codes, the other scans every frame. */
async function gossip(from: Phone, fromSid: string, to: Phone, toSid: string) {
  return to.party.scan(toSid, decodePartyQr(await from.party.shareFrames(fromSid)));
}

describe('offline party: host + 2 members, internet off, QR only → sync → server agrees', () => {
  it('plays the whole story', async () => {
    const [host, a, b] = [await newPhone('Mia'), await newPhone('Arif'), await newPhone('Sara')];
    const dir = tmp();

    // 1. Host creates the mission at their own GPS fix; members scan the invite and see the same check words.
    const created = await host.party.createInvite({ spec: SPEC, startFix: fixAt(host) });
    expect(created.frames).toHaveLength(1);
    const previews = [a, b].map((p) => p.party.preview(decodePartyQr(created.frames)));
    for (const pv of previews) {
      expect(pv.checkWords).toEqual(created.preview.checkWords);
      expect(pv).toMatchObject({ hostName: 'Mia', minutes: 30, goalText: '8 litter items each' });
      expect(pv.title).toContain('Litter Hunters');
    }

    // 2. Everyone goes offline and starts; from here on the QuestGuard blocks every request.
    for (const p of [host, a, b]) await expect(p.party.start({ invite: created.invite, startFix: fixAt(p), online: true })).rejects.toThrow(/Turn off/);
    const sid = new Map<Phone, string>();
    for (const p of [host, a, b]) {
      sid.set(p, await p.party.start({ invite: created.invite, startFix: fixAt(p, destinationPoint(DEMO_CENTER, 45, 20)), online: false }));
      p.guard.quest = (await p.sm.activeQuestId()) === sid.get(p);
      expect(p.guard.quest).toBe(true);
    }
    const callsBefore = [host, a, b].map((p) => p.guard.calls);
    await expect(a.api.myProgress()).rejects.toBeInstanceOf(QuestBlockedError);

    // 3. Join meetings (host ↔ each member), then play: walk, collect litter with a photo.
    for (const m of [a, b]) await meet(host, sid.get(host)!, m, sid.get(m)!, 'join');
    const litter = new Map<Phone, number>([[host, 9], [a, 8], [b, 10]]);
    for (const [i, p] of [host, a, b].entries()) {
      await stay(p.sm, sid.get(p)!, p.clock, DEMO_CENTER, 31 * 60, 15);
      const photo = await writePhoto(dir, `${p.name}`, await sharp({ create: { width: 40, height: 30, channels: 3, background: ['#2a6', '#a26', '#62a'][i]! } }).jpeg().toBuffer());
      await p.sm.captureEvidence({ sessionId: sid.get(p)!, taskId: 'litter', checkpointId: null, fileUri: photo.uri, sha256: photo.sha256, bytes: photo.bytes, fix: fixAt(p) });
      await p.sm.append(sid.get(p)!, 'TaskCompleted', { taskId: 'litter', quantity: litter.get(p)! });
    }

    // 4. Gossip: A → host, host → B. B never scanned A, yet sees A's progress (signed, relayed by the host).
    await gossip(a, sid.get(a)!, host, sid.get(host)!);
    expect(await gossip(host, sid.get(host)!, b, sid.get(b)!)).toEqual({ kind: 'summaries', members: 3 });
    const bView = await b.party.progress(sid.get(b)!);
    expect(bView).toMatchObject({ members: 3, total: 27, target: 24, reached: true, label: 'litter items' });
    expect(bView.checkWords).toEqual(created.preview.checkWords);
    // The host hasn't heard from B directly yet: it only knows itself + A. Gossip is eventual, not magic.
    expect((await host.party.progress(sid.get(host)!)).total).toBe(17);
    await gossip(b, sid.get(b)!, a, sid.get(a)!);
    await gossip(a, sid.get(a)!, host, sid.get(host)!);
    for (const p of [host, a, b]) expect((await p.party.progress(sid.get(p)!)).total).toBe(27);

    // 5. Wrap-up meetings, then finish offline. Not a single request was made during the party.
    for (const m of [a, b]) await meet(host, sid.get(host)!, m, sid.get(m)!, 'wrapup');
    expect((await host.party.sightings(sid.get(host)!)).map((s) => s.kind).sort()).toEqual(['join', 'join', 'wrapup', 'wrapup']);
    for (const p of [host, a, b]) {
      const done = await p.sm.finish(sid.get(p)!, 'rules', { shareWellbeing: false });
      expect(done.challenge.id).toBe(PARTY_CHALLENGE_ID);
      expect(done.score.completed).toBe(true);
      p.guard.quest = (await p.sm.activeQuestId()) !== null;
    }
    expect([host, a, b].map((p) => p.guard.calls)).toEqual(callsBefore);

    // 6. Back online: each phone syncs on its own. The server verifies all three with no party flags.
    for (const p of [b, host, a]) await syncUntilIdle(p);
    await ctx.jobs.drain();
    for (const p of [host, a, b]) {
      await p.sync.runOnce();
      expect((await p.api.session(sid.get(p)!)).verdict).toBe('verified');
      const flags = await ctx.db.query<{ code: string }>(
        `SELECT code FROM session_flags WHERE validation_run_id = (SELECT id FROM validation_runs WHERE session_id = $1 ORDER BY finished_at DESC LIMIT 1)`,
        [sid.get(p)!],
      );
      expect(flags.map((f) => f.code).filter((c) => /^(PARTY_|SIGHTING_|CHAIN_)/.test(c))).toEqual([]);
    }
    const server = await a.api.party(created.invite.body.partyId);
    expect(server.goal).toMatchObject({ members: 3, total: 27, target: 24, reached: true, pending: 0 });
    expect(server.members.map((m) => m.goalValue).sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([8, 9, 10]);
  }, 60_000);
});

describe('offline party: every bad scan is refused on the phone, and nothing reaches the chain', () => {
  it('refuses wrong roles, distance, foreign codes, replays, self-scans and post-finish scans; repeats are idempotent', async () => {
    const [host, m, outsider] = [await newPhone('Host'), await newPhone('Member'), await newPhone('Outsider')];
    const { invite, frames } = await host.party.createInvite({ spec: { ...SPEC, templateId: 'party_outside_v1' }, startFix: fixAt(host) });
    // Starting rules.
    await expect(m.sm.startParty({ invite, role: 'host', startFix: fixAt(m), online: false })).rejects.toThrow(/Only the host/);
    await expect(m.party.start({ invite, startFix: fixAt(m, destinationPoint(DEMO_CENTER, 0, 400)), online: false })).rejects.toThrow(/Stand next to the host/);
    const forged = { ...invite, body: { ...invite.body, spec: { ...invite.body.spec, targetMinutes: 90 as const } } };
    expect(() => m.party.preview(forged)).toThrow(PartyError);
    await expect(m.party.start({ invite: forged, startFix: fixAt(m), online: false })).rejects.toThrow(/can't be verified/);

    const hs = await host.party.start({ invite, startFix: fixAt(host), online: false });
    const ms = await m.party.start({ invite, startFix: fixAt(m), online: false });
    // An outsider in another party.
    const other = await outsider.party.createInvite({ spec: SPEC, startFix: fixAt(outsider) });
    const os = await outsider.party.start({ invite: other.invite, startFix: fixAt(outsider), online: false });
    const eventsOf = async (p: Phone, s: string) => (await p.sm.events(s)).length;
    const before = [await eventsOf(host, hs), await eventsOf(m, ms)];

    await expect(m.party.scan(ms, decodePartyQr(frames))).rejects.toThrow(/invite/);
    await expect(m.party.scan(ms, decodePartyQr(await outsider.party.offer(os)))).rejects.toThrow(/another party/);
    await expect(m.party.scan(ms, decodePartyQr(await m.party.offer(ms)))).rejects.toThrow(/your own code/);
    // An answer meant for someone else's code.
    const hostOffer = await host.party.offer(hs);
    const answer = await m.party.scan(ms, decodePartyQr(hostOffer), 'join');
    if (answer.kind !== 'answer') throw new Error('expected answer');
    await expect(outsider.party.scan(os, decodePartyQr(answer.frames))).rejects.toThrow(/another party/);
    const m2 = await newPhone('Member2');
    const m2s = await m2.party.start({ invite, startFix: fixAt(m2), online: false });
    // Scanning the same offer twice gives the same answer and ONE event; scanning the answer twice records once.
    const again = await m.party.scan(ms, decodePartyQr(hostOffer), 'join');
    expect(again).toEqual(answer);
    expect(await host.party.scan(hs, decodePartyQr(answer.frames), 'join')).toEqual({ kind: 'recorded', peerName: 'Member' });
    expect(await host.party.scan(hs, decodePartyQr(answer.frames), 'join')).toEqual({ kind: 'recorded', peerName: 'Member' });
    // The host's answer to M's code, scanned by another member who never showed that code.
    const mOffer = await m.party.offer(ms);
    const hostAnswer = await host.party.scan(hs, decodePartyQr(mOffer), 'checkpoint');
    if (hostAnswer.kind !== 'answer') throw new Error('expected answer');
    await expect(m2.party.scan(m2s, decodePartyQr(hostAnswer.frames))).rejects.toThrow(/someone else's code/);
    await expect(m.party.scan(ms, decodePartyQr(hostAnswer.frames))).resolves.toEqual({ kind: 'recorded', peerName: 'Host' });

    // Exactly the expected events: host 2 sightings, member 2 sightings (plus GPS flushes, none here).
    const sightings = async (p: Phone, s: string) => (await p.sm.events(s)).filter((e) => e.type === 'PeerSighting').length;
    expect(await sightings(host, hs)).toBe(2);
    expect(await sightings(m, ms)).toBe(2);
    expect(await sightings(m2, m2s)).toBe(0);
    expect((await eventsOf(host, hs)) - before[0]!).toBe(2);
    expect((await eventsOf(m, ms)) - before[1]!).toBe(2);

    // After finishing, no more meetings can be recorded (no location after the session, rule 9).
    await stay(m.sm, ms, m.clock, DEMO_CENTER, 60, 30);
    await m.sm.finish(ms, 'manual', { shareWellbeing: false });
    await expect(m.party.offer(ms)).rejects.toThrow(/before finishing/);
    // Progress can still be shared after finishing.
    expect((await m.party.shareFrames(ms)).length).toBeGreaterThan(0);
  }, 60_000);

  it('an 11-member summary bundle travels in ≤ 4 frames and merges on the receiving phone', async () => {
    const phones = await Promise.all(Array.from({ length: 11 }, (_, i) => newPhone(`P${i}`)));
    const host = phones[0]!;
    const { invite } = await host.party.createInvite({ spec: { ...SPEC, templateId: 'party_outside_v1' }, startFix: fixAt(host) });
    const sids = await Promise.all(phones.map((p) => p.party.start({ invite, startFix: fixAt(p), online: false })));
    for (const [i, p] of phones.entries()) await stay(p.sm, sids[i]!, p.clock, DEMO_CENTER, 5 * 60, 30);
    for (let i = 1; i < phones.length; i++) await gossip(phones[i]!, sids[i]!, host, sids[0]!);
    const frames = await host.party.shareFrames(sids[0]!);
    expect(frames.length).toBeLessThanOrEqual(4);
    const late = phones[5]!;
    expect(await late.party.scan(sids[5]!, decodePartyQr([...frames].reverse()))).toEqual({ kind: 'summaries', members: 11 });
    expect((await late.party.progress(sids[5]!)).members).toBe(11);
  }, 120_000);
});
