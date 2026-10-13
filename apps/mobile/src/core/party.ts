import {
  checkCode,
  decodePartyQr,
  definitionHash,
  encodePartyQr,
  newNonce,
  PartyQrCollector,
  PartySummary as PartySummarySchema,
  signParty,
  uuidv7,
  verifyInvite,
  verifySighting,
  type Fix,
  type PartyInvite,
  type PartyQrPayload,
  type PartySpec,
  type PartySummary,
  type SightingToken,
} from '@trina/contracts';
import { buildPartyDefinition, compileOrThrow, evaluatePartyGoal, mergeSummaries, PARTY_TEMPLATES, partyProgress, type PartyGoalResult } from '@trina/engine';
import type { KeyStore } from './confirmations';
import type { SessionManager } from './session-manager';
import type { SqlDb } from './sql';

export class PartyError extends Error {}
export type SightingKind = 'join' | 'checkpoint' | 'wrapup';

/** What a phone shows after reading an invite, before the player joins. */
export type InvitePreview = { invite: PartyInvite; title: string; checkWords: string[]; goalText: string; hostName: string; minutes: number };

/**
 * Offline Party Mode on the phone (ADR-033/034). Everything travels as signed QR codes; nothing here
 * touches the network.
 *  - Host: `createInvite` → members scan it → `preview` (signature + rebuilt definition + check words) → `start`.
 *  - Meeting (join / checkpoint / wrap-up), two-sided: A `offer`s a code; B `scan`s it (records a
 *    PeerSighting, gets an answer code); A `scan`s the answer (records its PeerSighting).
 *  - Progress: `shareFrames` packs every signed summary this phone knows; `scan` of a bundle merges it.
 */
export class PartyService {
  constructor(
    private readonly db: SqlDb,
    private readonly sessions: SessionManager,
    private readonly keys: KeyStore,
    private readonly ids: { userId: string; deviceId: string; displayName: string },
    private readonly now: () => number = Date.now,
  ) {}

  private async myKeys() {
    const k = await this.keys.get();
    if (!k) throw new PartyError('Sign in once with internet so this phone has a party key');
    return k;
  }

  private name() {
    return (this.ids.displayName || 'Player').slice(0, 40);
  }

  /** Host: a signed invite for a mission built from `spec` at the host's own GPS fix. */
  async createInvite(args: { spec: PartySpec; startFix: Fix }): Promise<{ invite: PartyInvite; frames: string[]; preview: InvitePreview }> {
    const k = await this.myKeys();
    const body = {
      partyId: uuidv7(this.now()),
      spec: args.spec,
      startFix: [Math.round(args.startFix.lng * 1e6) / 1e6, Math.round(args.startFix.lat * 1e6) / 1e6] as [number, number],
      hostUserId: this.ids.userId,
      hostDeviceId: this.ids.deviceId,
      hostName: this.name(),
      hostPublicKey: k.publicKeyHex,
      createdAt: new Date(this.now()).toISOString(),
    };
    const invite: PartyInvite = { t: 'pinv', body, sig: signParty('invite', body, k.secretKeyHex) };
    return { invite, frames: encodePartyQr(invite), preview: this.preview(invite) };
  }

  /** Member: check a scanned invite and show what it will build. Throws on anything not trustworthy. */
  preview(payload: PartyQrPayload): InvitePreview {
    if (payload.t !== 'pinv') throw new PartyError('That is not a party invite');
    if (!verifyInvite(payload)) throw new PartyError("This invite can't be verified");
    const inv = payload.body;
    const compiled = compileOrThrow(buildPartyDefinition(inv.spec, inv.startFix));
    const t = PARTY_TEMPLATES[inv.spec.templateId];
    return {
      invite: payload,
      title: compiled.definition.meta.title,
      checkWords: checkCode(definitionHash(compiled.definition)),
      goalText: `${t.goal.perMember(inv.spec)} ${t.goal.label} each`,
      hostName: inv.hostName,
      minutes: inv.spec.targetMinutes,
    };
  }

  /** Starts this phone's own party session (offline). */
  async start(args: { invite: PartyInvite; startFix: Fix; online: boolean; bootId?: string }): Promise<string> {
    const role = args.invite.body.hostUserId === this.ids.userId ? 'host' : 'member';
    return this.sessions.startParty({ ...args, role });
  }

  private async party(sessionId: string) {
    const p = await this.sessions.partyOf(sessionId);
    if (!p) throw new PartyError('This is not a party session');
    return p;
  }

  private async active(sessionId: string) {
    const p = await this.party(sessionId);
    if (p.status !== 'active' && p.status !== 'paused') throw new PartyError('Scan codes before finishing the party');
    return p;
  }

  private async token(sessionId: string, partyId: string, nonce: string, replyTo: string | null): Promise<SightingToken> {
    const k = await this.myKeys();
    const { seq, chainHead } = await this.sessions.head(sessionId);
    const body = { partyId, userId: this.ids.userId, deviceId: this.ids.deviceId, sessionId, name: this.name(), publicKey: k.publicKeyHex, seq, chainHead, nonce, replyTo };
    return { t: 'psig', body, sig: signParty('sighting', body, k.secretKeyHex) };
  }

  /** Step 1 of a meeting: this phone's code. */
  async offer(sessionId: string): Promise<string[]> {
    const p = await this.active(sessionId);
    const nonce = newNonce();
    const tok = await this.token(sessionId, p.invite.body.partyId, nonce, null);
    await this.db.run('INSERT INTO party_offers (nonce, session_id, created_at, used) VALUES (?, ?, ?, 0)', [nonce, sessionId, new Date(this.now()).toISOString()]);
    return encodePartyQr(tok);
  }

  /**
   * Handles any scanned party payload:
   *  - a peer's offer → records the meeting and returns this phone's answer code to show back,
   *  - an answer to this phone's offer → records the meeting,
   *  - a summary bundle → merges progress.
   */
  async scan(
    sessionId: string,
    payload: PartyQrPayload,
    kind: SightingKind = 'checkpoint',
  ): Promise<{ kind: 'answer'; frames: string[]; peerName: string } | { kind: 'recorded'; peerName: string } | { kind: 'summaries'; members: number }> {
    if (payload.t === 'psum') return { kind: 'summaries', members: await this.mergeBundle(sessionId, payload.items) };
    if (payload.t !== 'psig') throw new PartyError(payload.t === 'pinv' ? 'That is an invite. Use Join party instead' : 'That is not a party code');
    const p = await this.active(sessionId);
    const b = payload.body;
    if (!verifySighting(payload)) throw new PartyError("This code can't be verified");
    if (b.partyId !== p.invite.body.partyId) throw new PartyError('That player is in another party');
    if (b.userId === this.ids.userId) throw new PartyError("That's your own code");

    if (b.replyTo === null) {
      // A peer's offer. Scanning the same code twice returns the same answer (no duplicate events).
      const prev = await this.db.get<{ frames_json: string; peer_name: string }>('SELECT frames_json, peer_name FROM party_answers WHERE peer_nonce = ? AND session_id = ?', [b.nonce, sessionId]);
      if (prev) return { kind: 'answer', frames: JSON.parse(prev.frames_json), peerName: prev.peer_name };
      const myNonce = newNonce();
      await this.sessions.append(sessionId, 'PeerSighting', { sightingId: uuidv7(this.now()), kind, peer: payload, myNonce });
      const frames = encodePartyQr(await this.token(sessionId, b.partyId, myNonce, b.nonce));
      await this.db.run('INSERT INTO party_answers (peer_nonce, session_id, frames_json, peer_name, created_at) VALUES (?, ?, ?, ?, ?)', [b.nonce, sessionId, JSON.stringify(frames), b.name, new Date(this.now()).toISOString()]);
      return { kind: 'answer', frames, peerName: b.name };
    }
    // An answer: it must reply to a code THIS phone showed and hasn't used yet.
    const offer = await this.db.get<{ used: number }>('SELECT used FROM party_offers WHERE nonce = ? AND session_id = ?', [b.replyTo, sessionId]);
    if (!offer) throw new PartyError("This code answers someone else's code. Show your code again");
    if (Number(offer.used) === 1) return { kind: 'recorded', peerName: b.name };
    await this.sessions.append(sessionId, 'PeerSighting', { sightingId: uuidv7(this.now()), kind, peer: payload, myNonce: b.replyTo });
    await this.db.run('UPDATE party_offers SET used = 1 WHERE nonce = ?', [b.replyTo]);
    return { kind: 'recorded', peerName: b.name };
  }

  /** This phone's signed progress snapshot. */
  async mySummary(sessionId: string): Promise<PartySummary> {
    const p = await this.party(sessionId);
    const k = await this.myKeys();
    const { seq, chainHead } = await this.sessions.head(sessionId);
    const snap = await this.sessions.snapshot(sessionId);
    const body = { partyId: p.invite.body.partyId, sessionId, userId: this.ids.userId, name: this.name(), seq, chainHead, ...partyProgress(p.invite.body.spec, snap.score.facts) };
    return { body, publicKey: k.publicKeyHex, sig: signParty('summary', body, k.secretKeyHex) };
  }

  private async known(partyId: string): Promise<PartySummary[]> {
    const rows = await this.db.all<{ json: string }>('SELECT json FROM party_summaries WHERE party_id = ?', [partyId]);
    return rows.flatMap((r) => {
      const parsed = PartySummarySchema.safeParse(JSON.parse(r.json));
      return parsed.success ? [parsed.data] : [];
    });
  }

  private async mergeBundle(sessionId: string, incoming: PartySummary[]): Promise<number> {
    const p = await this.party(sessionId);
    const partyId = p.invite.body.partyId;
    const merged = mergeSummaries(partyId, await this.known(partyId), [...incoming, await this.mySummary(sessionId)]);
    await this.db.tx(async (t) => {
      for (const s of merged) {
        await t.run('INSERT INTO party_summaries (party_id, user_id, json) VALUES (?, ?, ?) ON CONFLICT(party_id, user_id) DO UPDATE SET json = excluded.json', [partyId, s.body.userId, JSON.stringify(s)]);
      }
    });
    return merged.length;
  }

  /** Every signed summary this phone knows (its own refreshed), as QR frames to show. */
  async shareFrames(sessionId: string): Promise<string[]> {
    const p = await this.party(sessionId);
    await this.mergeBundle(sessionId, []);
    return encodePartyQr({ t: 'psum', items: await this.known(p.invite.body.partyId) });
  }

  /** The party goal as this phone currently sees it (provisional until the server verifies). */
  async progress(sessionId: string): Promise<PartyGoalResult & { title: string; checkWords: string[] }> {
    const p = await this.party(sessionId);
    await this.mergeBundle(sessionId, []);
    const known = await this.known(p.invite.body.partyId);
    const pv = this.preview(p.invite);
    return { ...evaluatePartyGoal(p.invite.body.spec, known.map((s) => s.body)), title: pv.title, checkWords: pv.checkWords };
  }

  /** Meetings recorded in this phone's chain. */
  async sightings(sessionId: string): Promise<Array<{ name: string; kind: SightingKind; at: string }>> {
    const events = await this.sessions.events(sessionId);
    return events.flatMap((e) => (e.type === 'PeerSighting' ? [{ name: e.payload.peer.body.name, kind: e.payload.kind, at: e.clientTs }] : []));
  }
}

/** Collects multi-frame codes from the camera; returns the payload when complete. */
export function partyCollector() {
  const c = new PartyQrCollector();
  return {
    add: (text: string) => c.add(text),
    progress: () => c.progress,
  };
}

export { decodePartyQr };
