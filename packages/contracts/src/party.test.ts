import { describe, expect, it } from 'vitest';
import { generateDeviceKeyPair } from './confirmation';
import {
  checkCode,
  decodePartyQr,
  encodePartyQr,
  inviteHash,
  newNonce,
  PARTY_MAX_MEMBERS,
  PARTY_QR_FRAME_CHARS,
  PartyQrCollector,
  signParty,
  verifyInvite,
  verifyParty,
  verifySighting,
  verifySummary,
  type PartyInvite,
  type PartySummary,
  type SightingToken,
} from './party';
import { ActivityEvent } from './events';
import { uuidv7 } from './uuid';

const host = generateDeviceKeyPair();
const member = generateDeviceKeyPair();
const SHA = 'a'.repeat(64);

function invite(): PartyInvite {
  const body = {
    partyId: uuidv7(),
    spec: { v: 1 as const, templateId: 'party_cleanup_v1' as const, targetMinutes: 45 as const, levelTier: 'medium' as const, themeId: 'litter_hunters' as const },
    startFix: [88.3639, 22.5726] as [number, number],
    hostUserId: uuidv7(),
    hostDeviceId: uuidv7(),
    hostName: 'Mia',
    hostPublicKey: host.publicKeyHex,
    createdAt: '2026-10-12T05:00:00Z',
  };
  return { t: 'pinv', body, sig: signParty('invite', body, host.secretKeyHex) };
}

const PARTY = uuidv7();
function summary(i: number, seq = 5, partyId = PARTY): PartySummary {
  const body = { partyId, sessionId: uuidv7(), userId: uuidv7(), name: `Player ${i} with a longish name`, seq, chainHead: SHA, goalValue: 12, activeS: 2700, done: false };
  return { body, publicKey: member.publicKeyHex, sig: signParty('summary', body, member.secretKeyHex) };
}

describe('party signatures', () => {
  it('a signed invite verifies; any change breaks it', () => {
    const i = invite();
    expect(verifyInvite(i)).toBe(true);
    expect(verifyInvite({ ...i, body: { ...i.body, spec: { ...i.body.spec, targetMinutes: 90 } } })).toBe(false);
    expect(verifyInvite({ ...i, body: { ...i.body, hostPublicKey: member.publicKeyHex } })).toBe(false);
  });

  it('signatures are domain-separated by kind', () => {
    const body = { partyId: uuidv7(), userId: uuidv7(), deviceId: uuidv7(), sessionId: uuidv7(), name: 'A', publicKey: member.publicKeyHex, seq: 3, chainHead: SHA, nonce: newNonce(), replyTo: null };
    const tok: SightingToken = { t: 'psig', body, sig: signParty('sighting', body, member.secretKeyHex) };
    expect(verifySighting(tok)).toBe(true);
    // The same bytes signed as another kind are rejected.
    expect(verifyParty('sighting', body, signParty('sighting', body, host.secretKeyHex), member.publicKeyHex)).toBe(false);
  });

  it('a summary can be relayed but not altered', () => {
    const s = summary(1);
    expect(verifySummary(s)).toBe(true);
    expect(verifySummary({ ...s, body: { ...s.body, goalValue: 99 } })).toBe(false);
  });

  it('nonces are 16 hex chars and differ', () => {
    const a = newNonce();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(newNonce()).not.toBe(a);
  });
});

describe('party QR', () => {
  it('an invite fits in one frame and round-trips', () => {
    const i = invite();
    const frames = encodePartyQr(i);
    expect(frames).toHaveLength(1);
    expect(decodePartyQr(frames)).toEqual(i);
  });

  it('a full 11-member summary bundle fits in ≤ 6 frames, collected in any order', () => {
    const bundle = { t: 'psum' as const, items: Array.from({ length: PARTY_MAX_MEMBERS }, (_, i) => summary(i)) };
    const frames = encodePartyQr(bundle);
    expect(frames.length).toBeLessThanOrEqual(6);
    for (const f of frames) expect(f.length).toBeLessThanOrEqual(PARTY_QR_FRAME_CHARS + 16);
    const c = new PartyQrCollector();
    const shuffled = [...frames].reverse();
    let out = null;
    for (const f of shuffled) out = c.add(f) ?? out;
    expect(out).toEqual(bundle);
  });

  it('summaries from mixed parties still encode (JSON fallback) and round-trip', () => {
    const bundle = { t: 'psum' as const, items: [summary(1, 5, uuidv7()), summary(2, 5, uuidv7())] };
    expect(decodePartyQr(encodePartyQr(bundle))).toEqual(bundle);
  });

  it('rejects foreign or tampered frames', () => {
    expect(() => decodePartyQr(['hello'])).toThrow();
    const [f] = encodePartyQr(invite());
    expect(() => decodePartyQr([f!.replace('1/1', '2/1')])).toThrow();
  });

  it('the invite hash is stable and changes with the invite', () => {
    const i = invite();
    expect(inviteHash(i)).toBe(inviteHash(JSON.parse(JSON.stringify(i)) as PartyInvite));
    expect(inviteHash({ ...i, body: { ...i.body, hostName: 'Arif' } })).not.toBe(inviteHash(i));
  });
});

describe('check code', () => {
  it('is four words, deterministic per hash', () => {
    expect(checkCode(SHA)).toHaveLength(4);
    expect(checkCode('0123456789abcdef'.repeat(4))).toEqual(checkCode('0123456789abcdef'.repeat(4)));
    expect(checkCode('ffffff' + '0'.repeat(58))).not.toEqual(checkCode('000000' + '0'.repeat(58)));
  });
});

describe('party events', () => {
  it('PeerSighting and SessionStarted.party parse', () => {
    const body = { partyId: uuidv7(), userId: uuidv7(), deviceId: uuidv7(), sessionId: uuidv7(), name: 'A', publicKey: member.publicKeyHex, seq: 3, chainHead: SHA, nonce: newNonce(), replyTo: null };
    const env = { eventId: uuidv7(), sessionId: uuidv7(), seq: 4, schemaVersion: 1, clientTs: '2026-10-12T05:10:00Z', monoMs: 600_000, prevHash: SHA, hash: SHA };
    const ev = ActivityEvent.parse({ ...env, type: 'PeerSighting', payload: { sightingId: uuidv7(), kind: 'checkpoint', peer: { t: 'psig', body, sig: 'b'.repeat(128) }, myNonce: newNonce() } });
    expect(ev.type).toBe('PeerSighting');
    const started = ActivityEvent.parse({
      ...env,
      seq: 1,
      type: 'SessionStarted',
      payload: {
        challengeId: uuidv7(), challengeVersion: 1, definitionHash: SHA, deviceId: uuidv7(), userId: uuidv7(), teamId: null, bootId: 'b', clockOffsetMsAtDownload: 0,
        startFix: { lat: 22.5726, lng: 88.3639, acc: 5, ts: '2026-10-12T05:00:00Z' }, party: { invite: invite(), role: 'member' },
      },
    });
    expect(started.type === 'SessionStarted' && started.payload.party?.role).toBe('member');
  });
});
