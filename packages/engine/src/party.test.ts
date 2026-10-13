import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  definitionHash,
  generateDeviceKeyPair,
  inviteHash,
  newNonce,
  signParty,
  uuidv7,
  verifySighting,
  type LevelTier,
  type PartyInvite,
  type PartySpec,
  type PartySummary,
  type PartyTemplateId,
  type SightingToken,
  type TargetMinutes,
} from '@trina/contracts';
import {
  adaptQuest,
  buildPartyDefinition,
  compileOrThrow,
  computeFacts,
  evaluatePartyGoal,
  fold,
  mergeSummaries,
  PARTY_CHALLENGE_ID,
  PARTY_TEMPLATES,
  partyProgress,
  summarizeSession,
  type SessionSummary,
} from './index';
import { DEMO_CENTER, SessionBuilder } from './fixtures';

const TEMPLATES = Object.keys(PARTY_TEMPLATES) as PartyTemplateId[];
const MINUTES: TargetMinutes[] = [30, 45, 60, 90];
const TIERS: LevelTier[] = ['easy', 'medium', 'hard'];
const spec = (o: Partial<PartySpec> = {}): PartySpec => ({ v: 1, templateId: 'party_cleanup_v1', targetMinutes: 45, levelTier: 'medium', themeId: null, ...o });

describe('buildPartyDefinition', () => {
  it('every template × minutes × tier compiles with the default registry', () => {
    for (const templateId of TEMPLATES) for (const targetMinutes of MINUTES) for (const levelTier of TIERS) {
      expect(() => compileOrThrow(buildPartyDefinition(spec({ templateId, targetMinutes, levelTier }), DEMO_CENTER))).not.toThrow();
    }
  });

  it('is deterministic: same spec + start → same hash; GPS noise below 6 dp does not matter', () => {
    const a = definitionHash(compileOrThrow(buildPartyDefinition(spec(), DEMO_CENTER)).definition);
    const b = definitionHash(compileOrThrow(buildPartyDefinition(spec(), [DEMO_CENTER[0] + 1e-8, DEMO_CENTER[1] - 1e-8])).definition);
    expect(b).toBe(a);
  });

  it('any parameter change changes the hash', () => {
    const h = (s: PartySpec, at = DEMO_CENTER) => definitionHash(compileOrThrow(buildPartyDefinition(s, at)).definition);
    const base = h(spec());
    expect(h(spec({ targetMinutes: 60 }))).not.toBe(base);
    expect(h(spec({ levelTier: 'hard' }))).not.toBe(base);
    expect(h(spec({ templateId: 'party_trees_v1' }))).not.toBe(base);
    expect(h(spec(), [DEMO_CENTER[0] + 0.001, DEMO_CENTER[1]])).not.toBe(base);
  });

  it('a theme changes words only, never numbers (ADR-032)', () => {
    const plain = buildPartyDefinition(spec(), DEMO_CENTER);
    const themed = buildPartyDefinition(spec({ themeId: 'litter_hunters' }), DEMO_CENTER);
    expect(themed.meta.title).toContain('Litter Hunters');
    expect(themed.scoring).toEqual(plain.scoring);
    expect(themed.tasks).toEqual(plain.tasks);
    expect(themed.timing).toEqual(plain.timing);
    expect(themed.completion).toEqual(plain.completion);
  });

  it('rejects unknown templates; never rewards speed', () => {
    expect(() => buildPartyDefinition(spec({ templateId: 'nope' as PartyTemplateId }), DEMO_CENTER)).toThrow();
    for (const templateId of TEMPLATES) expect(buildPartyDefinition(spec({ templateId }), DEMO_CENTER).safety?.noSpeedRewards).toBe(true);
  });

  it('task counts scale with tier (trees: 1/2/3)', () => {
    expect(TIERS.map((levelTier) => buildPartyDefinition(spec({ templateId: 'party_trees_v1', levelTier }), DEMO_CENTER).tasks?.length)).toEqual([1, 2, 3]);
  });
});

/* ------------------------------ a full offline party ------------------------------ */

type Phone = { userId: string; deviceId: string; name: string; keys: ReturnType<typeof generateDeviceKeyPair>; b: SessionBuilder };

function makeInvite(host: Omit<Phone, 'b'>, s: PartySpec): PartyInvite {
  const body = { partyId: uuidv7(), spec: s, startFix: DEMO_CENTER, hostUserId: host.userId, hostDeviceId: host.deviceId, hostName: host.name, hostPublicKey: host.keys.publicKeyHex, createdAt: '2026-10-20T07:00:00Z' };
  return { t: 'pinv', body, sig: signParty('invite', body, host.keys.secretKeyHex) };
}

function token(p: Phone, partyId: string, replyTo: string | null): SightingToken {
  const { seq, chainHead } = p.b.head;
  const body = { partyId, userId: p.userId, deviceId: p.deviceId, sessionId: p.b.sessionId, name: p.name, publicKey: p.keys.publicKeyHex, seq, chainHead, nonce: newNonce(), replyTo };
  return { t: 'psig', body, sig: signParty('sighting', body, p.keys.secretKeyHex) };
}

/** Two-sided QR handshake: A shows, B scans + answers, A scans the answer. */
function sight(a: Phone, b: Phone, partyId: string, kind: 'join' | 'checkpoint' | 'wrapup') {
  const ta = token(a, partyId, null);
  expect(verifySighting(ta)).toBe(true);
  const tb = token(b, partyId, ta.body.nonce);
  b.b.emit('PeerSighting', { sightingId: uuidv7(), kind, peer: ta, myNonce: tb.body.nonce });
  a.b.emit('PeerSighting', { sightingId: uuidv7(), kind, peer: tb, myNonce: ta.body.nonce });
  return { ta, tb };
}

function summaryOf(p: Phone, s: PartySpec, partyId: string, compiled: ReturnType<typeof compileOrThrow>): PartySummary {
  const events = p.b.build();
  const facts = computeFacts(compiled, fold(compiled, events));
  const { seq, chainHead } = p.b.head;
  const body = { partyId, sessionId: p.b.sessionId, userId: p.userId, name: p.name, seq, chainHead, ...partyProgress(s, facts) };
  return { body, publicKey: p.keys.publicKeyHex, sig: signParty('summary', body, p.keys.secretKeyHex) };
}

function playParty(s: PartySpec, litter: number[]) {
  const people = litter.map((_, i) => ({ userId: uuidv7(), deviceId: uuidv7(), name: `P${i}`, keys: generateDeviceKeyPair() }));
  const invite = makeInvite(people[0]!, s);
  // Every phone rebuilds the definition from the invite alone and gets the same hash.
  const hashes = people.map(() => definitionHash(compileOrThrow(buildPartyDefinition(invite.body.spec, invite.body.startFix)).definition));
  const compiled = compileOrThrow(buildPartyDefinition(invite.body.spec, invite.body.startFix));
  const phones: Phone[] = people.map((p, i) => {
    const b = new SessionBuilder({ challengeId: PARTY_CHALLENGE_ID, definitionHash: hashes[i]!, userId: p.userId, deviceId: p.deviceId, start: DEMO_CENTER });
    b.emit('SessionStarted', {
      challengeId: PARTY_CHALLENGE_ID, challengeVersion: 1, definitionHash: hashes[i]!, deviceId: p.deviceId, userId: p.userId, teamId: null, bootId: 'b', clockOffsetMsAtDownload: 0,
      startFix: { lat: DEMO_CENTER[1], lng: DEMO_CENTER[0], acc: 5, ts: '2026-10-20T07:00:00.000Z' }, tzOffsetMin: 330, party: { invite, role: i === 0 ? 'host' : 'member' },
    });
    return { ...p, b };
  });
  const partyId = invite.body.partyId;
  for (const m of phones.slice(1)) sight(phones[0]!, m, partyId, 'join');
  phones.forEach((p, i) => {
    p.b.wait(s.targetMinutes * 60, 30);
    if (litter[i]! > 0) p.b.evidence('litter', 'c'.repeat(64)).completeTask('litter', litter[i]);
  });
  for (const m of phones.slice(1)) sight(phones[0]!, m, partyId, 'wrapup');
  phones.forEach((p) => p.b.complete());
  return { phones, invite, compiled, hashes, partyId, summaries: phones.map((p) => summaryOf(p, s, partyId, compiled)) };
}

describe('offline party, end to end (pure)', () => {
  it('three phones build the same mission, gossip in any order and agree on the goal', () => {
    const s = spec({ templateId: 'party_cleanup_v1', levelTier: 'medium' }); // 8 items each → 24 for 3
    const { hashes, summaries, partyId, phones, compiled } = playParty(s, [10, 8, 7]);
    expect(new Set(hashes).size).toBe(1);

    // Gossip: host meets A, A meets B; B never met the host but learns its progress through A.
    const [h, a, b] = summaries.map((x) => [x]) as [PartySummary[], PartySummary[], PartySummary[]];
    const ha = mergeSummaries(partyId, h, a);
    const ab = mergeSummaries(partyId, ha, b);
    const bSees = evaluatePartyGoal(s, ab.map((x) => x.body));
    expect(bSees).toMatchObject({ members: 3, total: 25, target: 24, reached: true, membersDone: 3, label: 'litter items' });
    // Any other order gives the same view.
    expect(mergeSummaries(partyId, mergeSummaries(partyId, b, h), a)).toEqual(ab);

    // Each chain recorded 2 sightings per member pair it took part in; summaries carry the party id.
    const st = fold(compiled, phones[1]!.b.build());
    expect(st.sightings).toBe(2);
    expect(st.party?.role).toBe('member');
    const sum = summarizeSession(compiled, st, { userId: phones[1]!.userId, challengeId: PARTY_CHALLENGE_ID, verified: false });
    expect(sum.partyId).toBe(partyId);
  });

  it('a party that falls short is not reached; a lone player never reaches a party goal', () => {
    const s = spec({ levelTier: 'hard' }); // 12 each
    const { summaries, partyId } = playParty(s, [12, 5]);
    const all = mergeSummaries(partyId, summaries, []);
    expect(evaluatePartyGoal(s, all.map((x) => x.body))).toMatchObject({ total: 17, target: 24, reached: false });
    expect(evaluatePartyGoal(s, all.slice(0, 1).map((x) => x.body))).toMatchObject({ members: 1, reached: false });
  });

  it('the invite hash identifies the mission; a tampered invite fails verification on another phone', async () => {
    const { invite } = playParty(spec(), [1, 1]);
    const { verifyInvite } = await import('@trina/contracts');
    expect(verifyInvite(invite)).toBe(true);
    expect(verifyInvite({ ...invite, body: { ...invite.body, spec: { ...invite.body.spec, targetMinutes: 30 } } })).toBe(false);
    expect(inviteHash(invite)).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* ------------------------------ gossip merge laws ------------------------------ */

describe('mergeSummaries', () => {
  const partyId = uuidv7();
  const keys = generateDeviceKeyPair();
  const users = Array.from({ length: 5 }, () => uuidv7());
  const mk = (userIdx: number, seq: number, head: string, pid = partyId): PartySummary => {
    const body = { partyId: pid, sessionId: uuidv7(), userId: users[userIdx]!, name: `U${userIdx}`, seq, chainHead: head.repeat(64), goalValue: seq, activeS: seq * 10, done: false };
    return { body, publicKey: keys.publicKeyHex, sig: signParty('summary', body, keys.secretKeyHex) };
  };
  const pool = [...users.keys()].flatMap((u) => [mk(u, 1, 'a'), mk(u, 3, 'b'), mk(u, 3, 'c'), mk(u, 7, 'd')]);
  const set = fc.array(fc.integer({ min: 0, max: pool.length - 1 }), { maxLength: 12 }).map((ix) => ix.map((i) => pool[i]!));
  const m = (a: PartySummary[], b: PartySummary[]) => mergeSummaries(partyId, a, b);

  it('is commutative, associative and idempotent (CRDT)', () => {
    fc.assert(
      fc.property(set, set, set, (a, b, c) => {
        expect(m(a, b)).toEqual(m(b, a));
        expect(m(m(a, b), c)).toEqual(m(a, m(b, c)));
        expect(m(m(a, b), m(a, b))).toEqual(m(a, b));
      }),
      { numRuns: 200 },
    );
  });

  it('keeps one entry per member: highest seq, ties broken the same way everywhere', () => {
    const out = m(pool, []);
    expect(out).toHaveLength(5);
    for (const s of out) expect(s.body.seq).toBe(7);
    const tie = m([mk(0, 3, 'b')], [mk(0, 3, 'c')]);
    expect(tie[0]!.body.chainHead[0]).toBe('c');
  });

  it('drops forged and foreign summaries', () => {
    const good = mk(1, 2, 'e');
    const forged = { ...good, body: { ...good.body, goalValue: 999 } };
    const other = mk(2, 9, 'f', uuidv7());
    expect(m([forged, other], [])).toEqual([]);
    expect(m([forged], [good])).toEqual([good]);
  });

  it('caps a party at 11 members, the same cut on every phone', () => {
    const k = generateDeviceKeyPair();
    const many = Array.from({ length: 13 }, (_, i) => {
      const body = { partyId, sessionId: uuidv7(), userId: uuidv7(), name: `M${i}`, seq: 1, chainHead: 'a'.repeat(64), goalValue: 1, activeS: 1, done: false };
      return { body, publicKey: k.publicKeyHex, sig: signParty('summary', body, k.secretKeyHex) } as PartySummary;
    });
    const out = m(many, []);
    expect(out).toHaveLength(11);
    expect(m([...many].reverse(), [])).toEqual(out);
  });
});

/* ------------------------------ adaptive ladder ------------------------------ */

let t0 = Date.parse('2026-10-01T06:00:00Z');
function q(dayKey: string, target: TargetMinutes, o: Partial<SessionSummary> = {}): SessionSummary {
  t0 += 1000;
  return {
    sessionId: uuidv7(), userId: 'u', challengeId: 'q', moduleIds: ['walking'], moduleVersions: { walking: 1 }, startMs: Date.parse(`${dayKey}T06:00:00Z`) + (t0 % 100_000),
    tzOffsetMin: 330, dayKey, weekKey: 'w', monthKey: 'm', dayKeyApprox: false, facts: { offline_s: target * 60 }, factLevels: {}, placeKeys: [], zoneIntervalsMs: [],
    status: 'completed', questStop: null, isQuest: true, questTargetMin: target, verified: true, ...o,
  };
}
const run = (h: SessionSummary[], rank: 'E' | 'C' | 'B' = 'B', todayKey = '2026-10-12') => adaptQuest(h, { rank, todayKey });

describe('adaptQuest', () => {
  it('starts at 30 min', () => {
    expect(run([])).toEqual({ targetMinutes: 30, levelTier: 'easy', reason: 'start' });
  });

  it('stays until 3 completed quests at the current tier, then steps up', () => {
    expect(run([q('2026-10-10', 30), q('2026-10-11', 30)])).toMatchObject({ targetMinutes: 30, reason: 'stay' });
    expect(run([q('2026-10-09', 30), q('2026-10-10', 30), q('2026-10-11', 30)])).toMatchObject({ targetMinutes: 45, levelTier: 'medium', reason: 'step_up' });
  });

  it('the streak restarts after a tier change', () => {
    expect(run([q('2026-10-07', 30), q('2026-10-08', 30), q('2026-10-09', 30), q('2026-10-10', 45)])).toMatchObject({ targetMinutes: 45, reason: 'stay' });
  });

  it('rank caps the ladder (E max 45, C max 60)', () => {
    const at45 = [q('2026-10-09', 45), q('2026-10-10', 45), q('2026-10-11', 45)];
    expect(run(at45, 'E')).toMatchObject({ targetMinutes: 45, reason: 'rank_cap' });
    expect(run(at45, 'C')).toMatchObject({ targetMinutes: 60, reason: 'step_up' });
    const at60 = [q('2026-10-09', 60), q('2026-10-10', 60), q('2026-10-11', 60)];
    expect(run(at60, 'C')).toMatchObject({ targetMinutes: 60, reason: 'rank_cap' });
    expect(run(at60, 'B')).toMatchObject({ targetMinutes: 90, levelTier: 'hard', reason: 'step_up' });
  });

  it('two force stops step down; safety stops never count', () => {
    const force = (d: string) => q(d, 45, { status: 'abandoned', questStop: 'force', facts: { offline_s: 600 } });
    const safety = (d: string) => q(d, 45, { status: 'abandoned', questStop: 'safety', facts: { offline_s: 600 } });
    expect(run([force('2026-10-10'), force('2026-10-11')])).toMatchObject({ targetMinutes: 30, reason: 'step_down' });
    expect(run([safety('2026-10-10'), safety('2026-10-11')])).toMatchObject({ targetMinutes: 45, reason: 'stay' });
  });

  it('two short quests (< 50 % offline) step down, never below 30', () => {
    const short = (d: string, t: TargetMinutes) => q(d, t, { facts: { offline_s: 60 } });
    expect(run([short('2026-10-10', 60), short('2026-10-11', 60)])).toMatchObject({ targetMinutes: 45, reason: 'step_down' });
    expect(run([short('2026-10-10', 30), short('2026-10-11', 30)])).toMatchObject({ targetMinutes: 30, reason: 'step_down' });
  });

  it('down beats up when both apply', () => {
    const h = [q('2026-10-08', 45), q('2026-10-09', 45), q('2026-10-10', 45), q('2026-10-11', 45, { status: 'abandoned', questStop: 'force' }), q('2026-10-11', 45, { status: 'abandoned', questStop: 'force' })];
    expect(run(h)).toMatchObject({ targetMinutes: 30, reason: 'step_down' });
  });

  it('welcomes back at 30 after 7 quiet days; old force stops are forgotten after 14 days', () => {
    expect(run([q('2026-10-01', 90), q('2026-10-02', 90), q('2026-10-03', 90)])).toMatchObject({ targetMinutes: 30, reason: 'welcome_back' });
    const old = (d: string) => q(d, 45, { status: 'abandoned', questStop: 'force' });
    expect(run([old('2026-09-20'), old('2026-09-21'), q('2026-10-11', 45)])).toMatchObject({ targetMinutes: 45, reason: 'stay' });
  });

  it('ignores non-quest sessions, unknown targets and future days', () => {
    const notQuest = q('2026-10-11', 30, { isQuest: false });
    const oldApp = q('2026-10-11', 30, { questTargetMin: undefined });
    const future = q('2026-10-20', 90);
    expect(run([notQuest, oldApp, future])).toMatchObject({ targetMinutes: 30, reason: 'start' });
  });

  it('is deterministic regardless of input order', () => {
    const h = [q('2026-10-09', 30), q('2026-10-10', 30), q('2026-10-11', 30)];
    expect(run([...h].reverse())).toEqual(run(h));
  });
});
