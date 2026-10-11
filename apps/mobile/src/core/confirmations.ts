import {
  ConfirmationBody,
  decodeQr,
  encodeQr,
  generateDeviceKeyPair,
  lowerOnly,
  signConfirmation,
  uuidv7,
  verifyConfirmation,
  type ConfirmationClaim,
  type ConfirmationRequest,
  type ConfirmationRole,
  type ConfirmationToken,
  type DeviceKeyPair,
} from '@trina/contracts';
import type { SessionManager } from './session-manager';
import type { SqlDb } from './sql';

/** Where the device's Ed25519 key lives: expo-secure-store on the phone, memory in tests. Never SQLite. */
export interface KeyStore {
  get(): Promise<DeviceKeyPair | null>;
  set(k: DeviceKeyPair): Promise<void>;
}

export class ConfirmationError extends Error {}

/**
 * The offline QR handshake (ADR-026, design §4.5):
 *  1. subject shows QR-A (`request`) with the claims,
 *  2. confirmer scans, may LOWER values, signs → ConfirmationIssued in the CONFIRMER's own session, shows QR-B,
 *  3. subject scans QR-B → signature checked on the phone → ConfirmationReceived in the subject's session.
 * The server trusts it only when both sides match, the key is registered, and both were co-present.
 */
export class ConfirmationService {
  constructor(
    private readonly db: SqlDb,
    private readonly sessions: SessionManager,
    private readonly keys: KeyStore,
    private readonly ids: { userId: string; deviceId: string; displayName: string },
    private readonly now: () => number = Date.now,
  ) {}

  /** The device key, created on first use. Returns the public key to register with the server. */
  async ensureKeys(): Promise<DeviceKeyPair> {
    const existing = await this.keys.get();
    if (existing) return existing;
    const k = generateDeviceKeyPair();
    await this.keys.set(k);
    return k;
  }

  private async sessionChallenge(sessionId: string): Promise<string> {
    const r = await this.db.get<{ challenge_id: string; status: string }>('SELECT challenge_id, status FROM sessions WHERE id = ?', [sessionId]);
    if (!r) throw new ConfirmationError('Unknown session');
    if (r.status !== 'active' && r.status !== 'paused') throw new ConfirmationError('Confirm before finishing the session');
    return r.challenge_id;
  }

  /** Step 1 (subject): QR-A text. */
  async request(subjectSessionId: string, claims: ConfirmationClaim[]): Promise<string> {
    if (!claims.length) throw new ConfirmationError('Pick at least one thing to confirm');
    const challengeId = await this.sessionChallenge(subjectSessionId);
    const req: ConfirmationRequest = { t: 'req', challengeId, subjectUserId: this.ids.userId, subjectSessionId, subjectName: this.ids.displayName.slice(0, 40), claims };
    return encodeQr(req);
  }

  /** Step 2 (confirmer): review, sign, record in the confirmer's own chain, return QR-B text. */
  async approve(qrA: string, issuerSessionId: string, opts: { role?: ConfirmationRole; approved?: ConfirmationClaim[] } = {}): Promise<{ qr: string; claims: ConfirmationClaim[]; request: ConfirmationRequest }> {
    const req = decodeQr(qrA);
    if (req.t !== 'req') throw new ConfirmationError('That is not a confirmation request');
    if (req.subjectUserId === this.ids.userId) throw new ConfirmationError("You can't confirm your own claims");
    const challengeId = await this.sessionChallenge(issuerSessionId);
    if (challengeId !== req.challengeId) throw new ConfirmationError('You are not playing the same challenge');
    const claims = lowerOnly(req.claims, opts.approved ?? req.claims);
    if (!claims.length) throw new ConfirmationError('Nothing to confirm');
    const keys = await this.ensureKeys();
    const body = ConfirmationBody.parse({
      confirmationId: uuidv7(this.now()), challengeId, subjectUserId: req.subjectUserId, subjectSessionId: req.subjectSessionId,
      issuerUserId: this.ids.userId, issuerDeviceId: this.ids.deviceId, role: opts.role ?? 'peer', claims,
    });
    const sig = signConfirmation(body, keys.secretKeyHex);
    // Build QR-B first: if it can't be shown, nothing is written to the chain.
    const token: ConfirmationToken = { t: 'tok', body, issuerName: this.ids.displayName.slice(0, 40), publicKey: keys.publicKeyHex, sig };
    const qr = encodeQr(token);
    await this.sessions.append(issuerSessionId, 'ConfirmationIssued', {
      confirmationId: body.confirmationId, challengeId, subjectUserId: body.subjectUserId, subjectSessionId: body.subjectSessionId, role: body.role, claims, sig,
    });
    await this.db.run(
      `INSERT INTO confirmations (id, role, session_id, counterpart_user_id, counterpart_name, claims_json, sig, key_checked, state, created_at) VALUES (?, 'issuer', ?, ?, ?, ?, ?, 1, 'issued', ?)`,
      [body.confirmationId, issuerSessionId, req.subjectUserId, req.subjectName, JSON.stringify(claims), sig, new Date(this.now()).toISOString()],
    );
    return { qr, claims, request: req };
  }

  /**
   * Step 3 (subject): verify and record. `participantKeys` (from the bundle) pins the confirmer's
   * registered key when known; otherwise the token's key is used and the server checks it later.
   */
  async accept(qrB: string, subjectSessionId: string, participantKeys: Array<{ userId: string; deviceId: string; publicKey: string }> = []): Promise<{ claims: ConfirmationClaim[]; issuerName: string; keyChecked: boolean }> {
    const tok = decodeQr(qrB);
    if (tok.t !== 'tok') throw new ConfirmationError('That is not a signed confirmation');
    const b = tok.body;
    if (b.subjectSessionId !== subjectSessionId || b.subjectUserId !== this.ids.userId) throw new ConfirmationError('This confirmation is for someone else');
    if (b.challengeId !== (await this.sessionChallenge(subjectSessionId))) throw new ConfirmationError('This confirmation is for another challenge');
    const pinned = participantKeys.find((k) => k.userId === b.issuerUserId && k.deviceId === b.issuerDeviceId);
    if (pinned && pinned.publicKey !== tok.publicKey) throw new ConfirmationError("The confirmer's key doesn't match");
    if (!verifyConfirmation(b, tok.sig, tok.publicKey)) throw new ConfirmationError('The signature is not valid');
    const already = await this.db.get('SELECT 1 FROM confirmations WHERE id = ?', [b.confirmationId]);
    if (already) return { claims: b.claims, issuerName: tok.issuerName, keyChecked: !!pinned };
    await this.sessions.append(subjectSessionId, 'ConfirmationReceived', {
      confirmationId: b.confirmationId, issuerUserId: b.issuerUserId, issuerDeviceId: b.issuerDeviceId, issuerPublicKey: tok.publicKey, role: b.role, claims: b.claims, sig: tok.sig,
    });
    await this.db.run(
      `INSERT INTO confirmations (id, role, session_id, counterpart_user_id, counterpart_name, claims_json, sig, key_checked, state, created_at) VALUES (?, 'subject', ?, ?, ?, ?, ?, ?, 'received', ?)`,
      [b.confirmationId, subjectSessionId, b.issuerUserId, tok.issuerName, JSON.stringify(b.claims), tok.sig, pinned ? 1 : 0, new Date(this.now()).toISOString()],
    );
    return { claims: b.claims, issuerName: tok.issuerName, keyChecked: !!pinned };
  }

  async list(sessionId: string) {
    return this.db.all<{ id: string; role: string; counterpart_name: string; claims_json: string; state: string; key_checked: number }>('SELECT * FROM confirmations WHERE session_id = ? ORDER BY created_at', [sessionId]);
  }
}
