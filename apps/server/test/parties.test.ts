/**
 * Server integration: Offline Party Mode (ADR-033/034). Parties created by sync, invite verification,
 * definition rebuild, two-sided sightings, CHAIN_FORK detection, re-validation, the members-only party
 * endpoint. Real PGlite, real HTTP via supertest.
 */
import {
  definitionHash,
  generateDeviceKeyPair,
  newNonce,
  signParty,
  uuidv7,
  type ActivityEvent,
  type LngLat,
  type PartyInvite,
  type PartySpec,
  type SightingToken,
} from '@trina/contracts';
import { buildPartyDefinition, buildQuestDefinition, compileOrThrow, DAILY_QUEST_CHALLENGE_ID, destinationPoint, PARTY_CHALLENGE_ID } from '@trina/engine';
import { DEMO_CENTER, SessionBuilder } from '@trina/engine/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hoursAgo, pushEvents, setup, type TestUser } from './helpers';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  t = await setup();
});
afterAll(async () => {
  await t.cleanup();
});

type Keys = ReturnType<typeof generateDeviceKeyPair>;
type Player = TestUser & { keys: Keys; name: string };

let n = 0;
async function player(): Promise<Player> {
  const name = `party${++n}`;
  const u = await t.user(name);
  const keys = generateDeviceKeyPair();
  expect((await t.api.put('/v1/me/devices/current/key').set(u.auth).send({ publicKey: keys.publicKeyHex })).status).toBe(204);
  return Object.assign(u, { keys, name });
}

const SPEC: PartySpec = { v: 1, templateId: 'party_outside_v1', targetMinutes: 30, levelTier: 'easy', themeId: 'park_explorers' };
const hashOf = (s: PartySpec = SPEC, at: LngLat = DEMO_CENTER) => definitionHash(compileOrThrow(buildPartyDefinition(s, at)).definition);

function invite(host: Player, o: { spec?: PartySpec; signWith?: string; publicKey?: string; partyId?: string } = {}): PartyInvite {
  const body = {
    partyId: o.partyId ?? uuidv7(), spec: o.spec ?? SPEC, startFix: DEMO_CENTER, hostUserId: host.user.id, hostDeviceId: host.deviceId, hostName: host.name,
    hostPublicKey: o.publicKey ?? host.keys.publicKeyHex, createdAt: hoursAgo(3),
  };
  return { t: 'pinv', body, sig: signParty('invite', body, o.signWith ?? host.keys.secretKeyHex) };
}

function session(p: Player, inv: PartyInvite, role: 'host' | 'member', o: { hash?: string; sessionId?: string; startTs?: string } = {}) {
  const ts = o.startTs ?? hoursAgo(3);
  const hash = o.hash ?? hashOf(inv.body.spec);
  const b = new SessionBuilder({ challengeId: PARTY_CHALLENGE_ID, definitionHash: hash, userId: p.user.id, deviceId: p.deviceId, start: DEMO_CENTER, startTs: ts, ...(o.sessionId ? { sessionId: o.sessionId } : {}) });
  b.emit('SessionStarted', {
    challengeId: PARTY_CHALLENGE_ID, challengeVersion: 1, definitionHash: hash, deviceId: p.deviceId, userId: p.user.id, teamId: null, bootId: 'b', clockOffsetMsAtDownload: 0,
    startFix: { lat: DEMO_CENTER[1], lng: DEMO_CENTER[0], acc: 6, ts }, tzOffsetMin: 330, party: { invite: inv, role },
  });
  return b;
}

type Phone = { p: Player; b: SessionBuilder };

function token(ph: Phone, partyId: string, replyTo: string | null, o: { signWith?: string; partyId?: string } = {}): SightingToken {
  const { seq, chainHead } = ph.b.head;
  const body = { partyId: o.partyId ?? partyId, userId: ph.p.user.id, deviceId: ph.p.deviceId, sessionId: ph.b.sessionId, name: ph.p.name, publicKey: ph.p.keys.publicKeyHex, seq, chainHead, nonce: newNonce(), replyTo };
  return { t: 'psig', body, sig: signParty('sighting', body, o.signWith ?? ph.p.keys.secretKeyHex) };
}

/** Two-sided QR handshake. */
function sight(a: Phone, b: Phone, partyId: string, kind: 'join' | 'checkpoint' | 'wrapup' = 'join') {
  const ta = token(a, partyId, null);
  const tb = token(b, partyId, ta.body.nonce);
  b.b.emit('PeerSighting', { sightingId: uuidv7(), kind, peer: ta, myNonce: tb.body.nonce });
  a.b.emit('PeerSighting', { sightingId: uuidv7(), kind, peer: tb, myNonce: ta.body.nonce });
}

async function push(p: Player, events: ActivityEvent[]) {
  const r = await pushEvents(t.api, p, events[0]!.sessionId, events);
  expect(r.status).toBe(200);
  return r.body.results[0] as { rejected: Array<{ code: string }> };
}

const flagsOf = async (sessionId: string) =>
  (await t.ctx.db.query<{ code: string }>(
    `SELECT f.code FROM session_flags f WHERE f.validation_run_id = (SELECT id FROM validation_runs WHERE session_id = $1 ORDER BY finished_at DESC, started_at DESC LIMIT 1)`,
    [sessionId],
  )).map((f) => f.code);
const verdictOf = async (sessionId: string) => (await t.ctx.db.one<{ validation_status: string }>('SELECT validation_status FROM activity_sessions WHERE id = $1', [sessionId]))?.validation_status;
const PARTY_FLAGS = /^(PARTY_|SIGHTING_|CHAIN_FORK)/;

/** A full honest party: host + members join by QR, play 31 min, wrap up by QR. */
async function honestParty(size: number) {
  const players = await Promise.all(Array.from({ length: size }, () => player()));
  const inv = invite(players[0]!);
  const phones: Phone[] = players.map((p, i) => ({ p, b: session(p, inv, i === 0 ? 'host' : 'member') }));
  for (const m of phones.slice(1)) sight(phones[0]!, m, inv.body.partyId, 'join');
  for (const ph of phones) ph.b.wait(31 * 60, 30);
  for (const m of phones.slice(1)) sight(phones[0]!, m, inv.body.partyId, 'wrapup');
  for (const ph of phones) ph.b.complete();
  return { inv, phones, partyId: inv.body.partyId };
}

describe('offline party: honest path', () => {
  it('three players sync on their own, need no join, all verify with no party flags; the goal is reached', async () => {
    const { phones, partyId } = await honestParty(3);
    for (const ph of phones) expect((await push(ph.p, ph.b.build())).rejected).toEqual([]);
    await t.ctx.jobs.drain();
    for (const ph of phones) {
      expect(await verdictOf(ph.b.sessionId)).toBe('verified');
      expect((await flagsOf(ph.b.sessionId)).filter((c) => PARTY_FLAGS.test(c))).toEqual([]);
    }
    const r = await t.api.get(`/v1/parties/${partyId}`).set(phones[1]!.p.auth);
    expect(r.status).toBe(200);
    expect(r.body.members).toHaveLength(3);
    expect(r.body.members.find((m: { role: string }) => m.role === 'host').userId).toBe(phones[0]!.p.user.id);
    expect(r.body.goal).toMatchObject({ members: 3, target: 72, reached: true, pending: 0, label: 'minutes outside' });
    expect(JSON.stringify(r.body)).not.toMatch(/"lat"|"lng"|startFix/);
  });

  it('party ids reveal nothing to non-members; the anchor challenge is never listed', async () => {
    const { phones, partyId } = await honestParty(2);
    for (const ph of phones) await push(ph.p, ph.b.build());
    const stranger = await player();
    expect((await t.api.get(`/v1/parties/${partyId}`).set(stranger.auth)).status).toBe(404);
    expect((await t.api.get(`/v1/parties/${uuidv7()}`).set(stranger.auth)).status).toBe(404);
    expect((await t.api.get(`/v1/challenges/${PARTY_CHALLENGE_ID}`).set(stranger.auth)).status).toBe(404);
  });

  it('re-pushing is idempotent: no duplicate party members', async () => {
    const { phones, partyId } = await honestParty(2);
    for (const ph of phones) await push(ph.p, ph.b.build());
    await push(phones[1]!.p, phones[1]!.b.build());
    const c = await t.ctx.db.one<{ n: string }>('SELECT count(*) AS n FROM party_members WHERE party_id = $1', [partyId]);
    expect(Number(c!.n)).toBe(2);
  });

  it('a member who syncs first is re-validated once the peer arrives (pending → matched), without cascading', async () => {
    const { phones } = await honestParty(2);
    const [host, member] = phones as [Phone, Phone];
    await push(member.p, member.b.build());
    await t.ctx.jobs.drain();
    expect(await flagsOf(member.b.sessionId)).toContain('SIGHTING_PENDING');
    expect(await verdictOf(member.b.sessionId)).toBe('verified'); // info only
    await push(host.p, host.b.build());
    await t.ctx.jobs.drain();
    expect(await flagsOf(member.b.sessionId)).not.toContain('SIGHTING_PENDING');
    const runs = async (sid: string) => Number((await t.ctx.db.one<{ n: string }>('SELECT count(*) AS n FROM validation_runs WHERE session_id = $1', [sid]))!.n);
    expect(await runs(member.b.sessionId)).toBe(2);
    expect(await runs(host.b.sessionId)).toBe(1);
  });
});

describe('offline party: invite and definition checks', () => {
  it('a party session without the invite is rejected', async () => {
    const p = await player();
    const ts = hoursAgo(3);
    const b = new SessionBuilder({ challengeId: PARTY_CHALLENGE_ID, definitionHash: hashOf(), userId: p.user.id, deviceId: p.deviceId, start: DEMO_CENTER, startTs: ts });
    b.emit('SessionStarted', { challengeId: PARTY_CHALLENGE_ID, challengeVersion: 1, definitionHash: hashOf(), deviceId: p.deviceId, userId: p.user.id, teamId: null, bootId: 'b', clockOffsetMsAtDownload: 0, startFix: { lat: DEMO_CENTER[1], lng: DEMO_CENTER[0], acc: 6, ts } });
    expect((await push(p, b.wait(60).complete().build())).rejected[0]?.code).toBe('SCHEMA_INVALID');
  });

  it('a device that built a different mission → PARTY_DEFINITION_MISMATCH', async () => {
    const host = await player();
    const inv = invite(host);
    const b = session(host, inv, 'host', { hash: hashOf({ ...SPEC, targetMinutes: 90 }) }).wait(31 * 60, 30).complete();
    await push(host, b.build());
    await t.ctx.jobs.drain();
    expect(await flagsOf(b.sessionId)).toContain('PARTY_DEFINITION_MISMATCH');
    expect(await verdictOf(b.sessionId)).toBe('needs_review');
  });

  it('a forged invite → PARTY_INVITE_INVALID; an invite from an unregistered key → PARTY_HOST_KEY_UNKNOWN', async () => {
    const host = await player();
    const forged = invite(host, { signWith: generateDeviceKeyPair().secretKeyHex });
    const a = session(host, forged, 'host').wait(31 * 60, 30).complete();
    await push(host, a.build());
    const other = generateDeviceKeyPair();
    const unregistered = invite(host, { signWith: other.secretKeyHex, publicKey: other.publicKeyHex });
    const b = session(host, unregistered, 'host').wait(31 * 60, 30).complete();
    await push(host, b.build());
    await t.ctx.jobs.drain();
    expect(await flagsOf(a.sessionId)).toContain('PARTY_INVITE_INVALID');
    const fb = await flagsOf(b.sessionId);
    expect(fb).toContain('PARTY_HOST_KEY_UNKNOWN');
    expect(fb).not.toContain('PARTY_INVITE_INVALID');
  });

  it('two different invites for one party id → PARTY_INVITE_CONFLICT; a member claiming host → PARTY_ROLE_INVALID', async () => {
    const host = await player();
    const member = await player();
    const inv = invite(host);
    const twin = invite(host, { partyId: inv.body.partyId, spec: { ...SPEC, levelTier: 'hard' } });
    const a = session(host, inv, 'host').wait(31 * 60, 30).complete();
    const b = session(member, twin, 'host').wait(31 * 60, 30).complete();
    await push(host, a.build());
    await push(member, b.build());
    await t.ctx.jobs.drain();
    const f = await flagsOf(b.sessionId);
    expect(f).toEqual(expect.arrayContaining(['PARTY_INVITE_CONFLICT', 'PARTY_ROLE_INVALID']));
    expect(await flagsOf(a.sessionId)).not.toContain('PARTY_INVITE_CONFLICT');
  });

  it('a 12th player → PARTY_FULL (warn), the session still counts', async () => {
    const players = await Promise.all(Array.from({ length: 12 }, () => player()));
    const inv = invite(players[0]!);
    const ids: string[] = [];
    for (const [i, p] of players.entries()) {
      const b = session(p, inv, i === 0 ? 'host' : 'member').wait(31 * 60, 60).complete();
      ids.push(b.sessionId);
      await push(p, b.build());
    }
    await t.ctx.jobs.drain();
    expect(await flagsOf(ids[11]!)).toContain('PARTY_FULL');
    expect(await flagsOf(ids[10]!)).not.toContain('PARTY_FULL');
    expect(await verdictOf(ids[11]!)).toBe('verified_with_notes');
  });
});

describe('offline party: sightings and chain entanglement (flag, don\'t accuse)', () => {
  async function pair() {
    const [a, b] = [await player(), await player()];
    const inv = invite(a);
    return { inv, A: { p: a, b: session(a, inv, 'host') } as Phone, B: { p: b, b: session(b, inv, 'member') } as Phone, partyId: inv.body.partyId };
  }

  it('forged, foreign, self and unregistered-key sightings are each flagged critical', async () => {
    const { A, B, partyId } = await pair();
    const stranger = await player();
    const S: Phone = { p: stranger, b: new SessionBuilder({ challengeId: PARTY_CHALLENGE_ID, definitionHash: hashOf(), userId: stranger.user.id, deviceId: stranger.deviceId, start: DEMO_CENTER }) };
    S.b.start();
    const forged = token(B, partyId, null, { signWith: generateDeviceKeyPair().secretKeyHex });
    const foreign = token(B, partyId, null, { partyId: uuidv7() });
    const self = token(A, partyId, null);
    const k = generateDeviceKeyPair();
    const unknownKey = token({ p: { ...stranger, keys: k }, b: S.b }, partyId, null);
    for (const peer of [forged, foreign, self, unknownKey]) A.b.emit('PeerSighting', { sightingId: uuidv7(), kind: 'checkpoint', peer, myNonce: newNonce() });
    A.b.wait(31 * 60, 30).complete();
    await push(A.p, A.b.build());
    await t.ctx.jobs.drain();
    const f = await flagsOf(A.b.sessionId);
    expect(f).toEqual(expect.arrayContaining(['SIGHTING_SIG_INVALID', 'SIGHTING_WRONG_PARTY', 'SIGHTING_SELF', 'SIGHTING_KEY_UNKNOWN']));
    expect(await verdictOf(A.b.sessionId)).toBe('needs_review');
  });

  it('a one-sided sighting (the peer synced but never recorded it) → SIGHTING_UNMATCHED', async () => {
    const { A, B, partyId } = await pair();
    A.b.emit('PeerSighting', { sightingId: uuidv7(), kind: 'checkpoint', peer: token(B, partyId, null), myNonce: newNonce() });
    A.b.wait(31 * 60, 30).complete();
    B.b.wait(31 * 60, 30).complete();
    await push(B.p, B.b.build());
    await push(A.p, A.b.build());
    await t.ctx.jobs.drain();
    expect(await flagsOf(A.b.sessionId)).toContain('SIGHTING_UNMATCHED');
    expect(await verdictOf(A.b.sessionId)).toBe('verified_with_notes');
  });

  it('an answer that does not reply to this phone\'s nonce → SIGHTING_REPLAY', async () => {
    const { A, B, partyId } = await pair();
    const old = token(B, partyId, newNonce()); // replied to someone else's code
    A.b.emit('PeerSighting', { sightingId: uuidv7(), kind: 'checkpoint', peer: old, myNonce: newNonce() });
    A.b.wait(31 * 60, 30).complete();
    await push(A.p, A.b.build());
    await t.ctx.jobs.drain();
    expect(await flagsOf(A.b.sessionId)).toContain('SIGHTING_REPLAY');
  });

  it('phones that "met" while 1.5 km apart → SIGHTING_DISTANT on both', async () => {
    const { A, B, partyId } = await pair();
    sight(A, B, partyId, 'join');
    B.b.wait(5 * 60, 30).moveTo(destinationPoint(DEMO_CENTER, 90, 1500), 1.4, 20).wait(60, 30);
    A.b.wait((B.b.now - A.b.now) / 1000, 30); // same moment on both phones
    sight(A, B, partyId, 'wrapup');
    A.b.wait(31 * 60 - A.b.now / 1000, 30).complete();
    B.b.wait(60).complete();
    await push(A.p, A.b.build());
    await push(B.p, B.b.build());
    await t.ctx.jobs.drain();
    for (const sid of [A.b.sessionId, B.b.sessionId]) {
      const f = await flagsOf(sid);
      expect(f).toContain('SIGHTING_DISTANT');
      expect(f).not.toContain('SIGHTING_CLOCK');
    }
  });

  it('the two sides of one meeting recorded minutes apart → SIGHTING_CLOCK', async () => {
    const { A, B, partyId } = await pair();
    B.b.wait(10 * 60, 30); // B's clock is 10 minutes ahead of A's at the "same" handshake
    sight(A, B, partyId, 'checkpoint');
    A.b.wait(31 * 60, 30).complete();
    B.b.wait(31 * 60, 30).complete();
    await push(A.p, A.b.build());
    await push(B.p, B.b.build());
    await t.ctx.jobs.drain();
    expect(await flagsOf(A.b.sessionId)).toContain('SIGHTING_CLOCK');
    expect(await flagsOf(B.b.sessionId)).toContain('SIGHTING_CLOCK');
  });

  it('a chain rewritten after a teammate recorded it → CHAIN_FORK on the rewritten session (detected from the OTHER phone)', async () => {
    const { A, B, partyId, inv } = await pair();
    B.b.wait(5 * 60, 30);
    sight(A, B, partyId, 'checkpoint');
    A.b.wait(31 * 60, 30).complete();
    // B "edits" its log before syncing: same session id, rebuilt events, consistent hashes.
    const rewritten = session(B.p, inv, 'member', { sessionId: B.b.sessionId }).wait(5 * 60, 30).wait(31 * 60, 30).complete();
    await push(A.p, A.b.build());
    await push(B.p, rewritten.build());
    await t.ctx.jobs.drain();
    const fb = await flagsOf(B.b.sessionId);
    expect(fb).toContain('CHAIN_FORK');
    expect(await verdictOf(B.b.sessionId)).toBe('needs_review');
    // B's own hash chain is internally valid: only the teammate's record exposes it.
    expect(fb).not.toContain('CHAIN_BROKEN');
    expect(await flagsOf(A.b.sessionId)).not.toContain('CHAIN_FORK');
  });

  it('the party goal counts verified sessions only', async () => {
    const { phones, partyId } = await honestParty(2);
    await push(phones[0]!.p, phones[0]!.b.build());
    await t.ctx.jobs.drain();
    const r = await t.api.get(`/v1/parties/${partyId}`).set(phones[0]!.p.auth);
    expect(r.body.members).toHaveLength(1);
    expect(r.body.goal).toMatchObject({ members: 1, reached: false, pending: 0 });
    await push(phones[1]!.p, phones[1]!.b.build());
    await t.ctx.jobs.drain();
    const r2 = await t.api.get(`/v1/parties/${partyId}`).set(phones[0]!.p.auth);
    expect(r2.body.goal).toMatchObject({ members: 2, reached: true });
  });
});

describe('adaptive Daily Quests (ADR-032)', () => {
  function quest(p: Player, targetMinutes: 30 | 45 | 60 | 90, startTs: string, minutes: number) {
    const spec = { templateId: 'outside_v1', targetMinutes, levelTier: 'easy' as const };
    const hash = definitionHash(compileOrThrow(buildQuestDefinition(spec, DEMO_CENTER)).definition);
    const b = new SessionBuilder({ challengeId: DAILY_QUEST_CHALLENGE_ID, definitionHash: hash, userId: p.user.id, deviceId: p.deviceId, start: DEMO_CENTER, startTs });
    b.emit('SessionStarted', {
      challengeId: DAILY_QUEST_CHALLENGE_ID, challengeVersion: 1, definitionHash: hash, deviceId: p.deviceId, userId: p.user.id, teamId: null, bootId: 'b', clockOffsetMsAtDownload: 0,
      startFix: { lat: DEMO_CENTER[1], lng: DEMO_CENTER[0], acc: 6, ts: startTs }, tzOffsetMin: 330, quest: spec,
    });
    return b.emit('ConnectivityChanged', { online: false, transport: 'none' }).wait(minutes * 60, 30).complete();
  }

  it('suggests 30 min to a new player, steps up after 3 verified quests at that length, capped by rank', async () => {
    const p = await player();
    const first = (await t.api.get('/v1/me/quests').set(p.auth)).body;
    expect(first).toMatchObject({ targetMinutes: 30, targetReason: 'start', maxMinutes: 45 });
    for (const h of [72, 48, 24]) await push(p, quest(p, 30, hoursAgo(h), 31).build());
    await t.ctx.jobs.drain();
    const next = (await t.api.get('/v1/me/quests').set(p.auth)).body;
    expect(next).toMatchObject({ targetMinutes: 45, targetReason: 'step_up' });
  });

  it('a quest longer than the rank allows still counts, with a note (flag, don\'t accuse)', async () => {
    const p = await player();
    const b = quest(p, 90, hoursAgo(3), 91);
    await push(p, b.build());
    await t.ctx.jobs.drain();
    expect(await flagsOf(b.sessionId)).toContain('QUEST_ADAPT_OUT_OF_BOUNDS');
    expect(await verdictOf(b.sessionId)).toBe('verified_with_notes');
  });
});
