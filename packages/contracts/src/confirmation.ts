import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { Id } from './common';
import { canonicalJson } from './hashing';

/**
 * Signed two-sided confirmations (ADR-026). The confirmer's device signs the claim with its own
 * Ed25519 key; the claim is written into the CONFIRMER's hash chain (ConfirmationIssued) and,
 * after a QR handshake, into the subject's chain (ConfirmationReceived). The server only trusts a
 * claim when both sides match, the signature verifies against the registered device key, and the
 * two people were co-present. Works fully offline.
 */
export const ConfirmationRole = z.enum(['organizer', 'peer']);
export type ConfirmationRole = z.infer<typeof ConfirmationRole>;

/** `ref` is `<moduleId>.<counterId>` for counters, or the challenge task id for tasks. */
export const ConfirmationClaim = z
  .object({
    kind: z.enum(['counter', 'task']),
    ref: z.string().regex(/^[a-z0-9_-]{1,32}(\.[a-z][a-z0-9_]{1,31})?$/i),
    value: z.int().min(1).max(500),
  })
  .strict();
export type ConfirmationClaim = z.infer<typeof ConfirmationClaim>;

/** 1–6 claims, each counter or task at most once (the engine sums counter claims, so a repeat would double it). */
export const ConfirmationClaims = z
  .array(ConfirmationClaim)
  .min(1)
  .max(6)
  .refine((cs) => new Set(cs.map((c) => `${c.kind}:${c.ref}`)).size === cs.length, { message: 'Each counter or task can be confirmed once' });

export const PublicKeyHex = z.string().regex(/^[0-9a-f]{64}$/);
export const SignatureHex = z.string().regex(/^[0-9a-f]{128}$/);

/** Exactly the fields that are signed. Order-independent via canonical JSON. */
export const ConfirmationBody = z
  .object({
    confirmationId: Id,
    challengeId: Id,
    subjectUserId: Id,
    subjectSessionId: Id,
    issuerUserId: Id,
    issuerDeviceId: Id,
    role: ConfirmationRole,
    claims: ConfirmationClaims,
  })
  .strict();
export type ConfirmationBody = z.infer<typeof ConfirmationBody>;

/** QR-A: the subject asks; nothing is signed yet. */
export const ConfirmationRequest = z
  .object({
    t: z.literal('req'),
    challengeId: Id,
    subjectUserId: Id,
    subjectSessionId: Id,
    subjectName: z.string().max(40),
    claims: ConfirmationClaims,
  })
  .strict();
export type ConfirmationRequest = z.infer<typeof ConfirmationRequest>;

/** QR-B: the confirmer's signed answer (may LOWER values, never raise them). */
export const ConfirmationToken = z
  .object({ t: z.literal('tok'), body: ConfirmationBody, issuerName: z.string().max(40), publicKey: PublicKeyHex, sig: SignatureHex })
  .strict();
export type ConfirmationToken = z.infer<typeof ConfirmationToken>;

export function confirmationMessage(body: ConfirmationBody): Uint8Array {
  return utf8ToBytes(`trina-confirmation:v1:${canonicalJson(ConfirmationBody.parse(body))}`);
}

export type DeviceKeyPair = { secretKeyHex: string; publicKeyHex: string };

/** New Ed25519 key pair (uses crypto.getRandomValues: Node, Hermes with react-native-get-random-values). */
export function generateDeviceKeyPair(): DeviceKeyPair {
  const sk = ed25519.utils.randomSecretKey();
  return { secretKeyHex: bytesToHex(sk), publicKeyHex: bytesToHex(ed25519.getPublicKey(sk)) };
}

export function signConfirmation(body: ConfirmationBody, secretKeyHex: string): string {
  return bytesToHex(ed25519.sign(confirmationMessage(body), hexToBytes(secretKeyHex)));
}

export function verifyConfirmation(body: ConfirmationBody, sigHex: string, publicKeyHex: string): boolean {
  try {
    return ed25519.verify(hexToBytes(sigHex), confirmationMessage(body), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

/** Claims after review: each value may only go DOWN (or be dropped), never up. */
export function lowerOnly(requested: ConfirmationClaim[], approved: ConfirmationClaim[]): ConfirmationClaim[] {
  const out: ConfirmationClaim[] = [];
  for (const a of approved) {
    const r = requested.find((x) => x.kind === a.kind && x.ref === a.ref);
    if (r && !out.some((o) => o.kind === a.kind && o.ref === a.ref)) out.push({ ...a, value: Math.min(a.value, r.value) });
  }
  return out;
}

/* ------------------------------ QR encoding ------------------------------ */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function b64urlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += B64[n & 63]!;
  }
  return out;
}

/** Strict: one spelling per payload (unused trailing bits must be zero), so a changed character never decodes the same. */
function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error('Invalid QR payload');
  const last = B64.indexOf(s[s.length - 1] ?? 'A');
  if ((s.length % 4 === 2 && (last & 15) !== 0) || (s.length % 4 === 3 && (last & 3) !== 0)) throw new Error('Invalid QR payload');
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const c = [0, 1, 2, 3].map((k) => (i + k < s.length ? B64.indexOf(s[i + k]!) : -1));
    const n = (c[0]! << 18) | (c[1]! << 12) | (Math.max(0, c[2]!) << 6) | Math.max(0, c[3]!);
    bytes.push((n >> 16) & 255);
    if (c[2]! >= 0) bytes.push((n >> 8) & 255);
    if (c[3]! >= 0) bytes.push(n & 255);
  }
  return new Uint8Array(bytes);
}

/** Pure UTF-8 decoder (TextDecoder is not available on every JS engine, e.g. older Hermes). */
function utf8Decode(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i++]!;
    let cp: number;
    if (c < 0x80) cp = c;
    else if (c < 0xe0) cp = ((c & 0x1f) << 6) | (b[i++]! & 0x3f);
    else if (c < 0xf0) cp = ((c & 0x0f) << 12) | ((b[i++]! & 0x3f) << 6) | (b[i++]! & 0x3f);
    else cp = ((c & 0x07) << 18) | ((b[i++]! & 0x3f) << 12) | ((b[i++]! & 0x3f) << 6) | (b[i++]! & 0x3f);
    out += String.fromCodePoint(cp);
  }
  return out;
}

/** v1: base64url(canonical JSON). Still decoded; written only when the compact form can't represent a payload exactly. */
export const QR_PREFIX = 'TRINA1:';
/** v2: base64url(compact binary): 16-byte UUIDs, raw key/signature bytes. A signed 6-claim token fits in 1 KB. */
export const QR_PREFIX_COMPACT = 'TRINA2:';
/** QR payloads stay ≤ 1 KB so they scan reliably on low-end cameras. */
export const QR_MAX_CHARS = 1024;

export function isTrinaQr(text: string): boolean {
  return text.startsWith(QR_PREFIX) || text.startsWith(QR_PREFIX_COMPACT);
}

const ROLES = ['organizer', 'peer'] as const;
const KINDS = ['counter', 'task'] as const;

function packCompact(p: ConfirmationRequest | ConfirmationToken): Uint8Array {
  const out: number[] = [];
  const u8 = (n: number) => {
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error('compact: byte out of range');
    out.push(n);
  };
  const raw = (b: Uint8Array) => out.push(...b);
  const id = (u: string) => raw(hexToBytes(u.replace(/-/g, '')));
  const str = (x: string) => {
    const b = utf8ToBytes(x);
    u8(b.length);
    raw(b);
  };
  const claims = (cs: ConfirmationClaim[]) => {
    u8(cs.length);
    for (const c of cs) {
      u8(KINDS.indexOf(c.kind));
      u8(c.value >> 8);
      u8(c.value & 255);
      str(c.ref);
    }
  };
  if (p.t === 'req') {
    u8(1);
    id(p.challengeId);
    id(p.subjectUserId);
    id(p.subjectSessionId);
    str(p.subjectName);
    claims(p.claims);
  } else {
    const b = p.body;
    u8(2);
    for (const u of [b.confirmationId, b.challengeId, b.subjectUserId, b.subjectSessionId, b.issuerUserId, b.issuerDeviceId]) id(u);
    u8(ROLES.indexOf(b.role));
    claims(b.claims);
    str(p.issuerName);
    raw(hexToBytes(p.publicKey));
    raw(hexToBytes(p.sig));
  }
  return new Uint8Array(out);
}

function unpackCompact(bytes: Uint8Array): unknown {
  let i = 0;
  const take = (n: number) => {
    if (i + n > bytes.length) throw new Error('Invalid QR payload');
    const b = bytes.subarray(i, i + n);
    i += n;
    return b;
  };
  const u8 = () => take(1)[0]!;
  const hex = (n: number) => bytesToHex(take(n));
  const id = () => {
    const h = hex(16);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  const str = () => utf8Decode(take(u8()));
  const claims = () =>
    Array.from({ length: u8() }, () => {
      const kind = KINDS[u8()];
      const value = (u8() << 8) | u8();
      return { kind, ref: str(), value };
    });
  const type = u8();
  let out: unknown;
  if (type === 1) {
    out = { t: 'req', challengeId: id(), subjectUserId: id(), subjectSessionId: id(), subjectName: str(), claims: claims() };
  } else if (type === 2) {
    const [confirmationId, challengeId, subjectUserId, subjectSessionId, issuerUserId, issuerDeviceId] = [id(), id(), id(), id(), id(), id()];
    const role = ROLES[u8()];
    const cs = claims();
    out = { t: 'tok', body: { confirmationId, challengeId, subjectUserId, subjectSessionId, issuerUserId, issuerDeviceId, role, claims: cs }, issuerName: str(), publicKey: hex(32), sig: hex(64) };
  } else throw new Error('Invalid QR payload');
  if (i !== bytes.length) throw new Error('Invalid QR payload');
  return out;
}

const parsePayload = (raw: unknown): ConfirmationRequest | ConfirmationToken =>
  (raw as { t?: string }).t === 'req' ? ConfirmationRequest.parse(raw) : ConfirmationToken.parse(raw);

export function encodeQr(payload: ConfirmationRequest | ConfirmationToken): string {
  let text: string | null = null;
  try {
    const compact = packCompact(payload);
    // Only if it decodes back to exactly the same payload (e.g. lowercase UUIDs), so a signature can never break.
    if (canonicalJson(unpackCompact(compact)) === canonicalJson(payload)) text = QR_PREFIX_COMPACT + b64urlEncode(compact);
  } catch {
    /* not representable compactly: use JSON */
  }
  text ??= QR_PREFIX + b64urlEncode(utf8ToBytes(canonicalJson(payload)));
  if (text.length > QR_MAX_CHARS) throw new Error('QR payload too large');
  return text;
}

export function decodeQr(text: string): ConfirmationRequest | ConfirmationToken {
  if (!isTrinaQr(text) || text.length > QR_MAX_CHARS) throw new Error('Not a Trina confirmation code');
  if (text.startsWith(QR_PREFIX_COMPACT)) return parsePayload(unpackCompact(b64urlDecode(text.slice(QR_PREFIX_COMPACT.length))));
  return parsePayload(JSON.parse(utf8Decode(b64urlDecode(text.slice(QR_PREFIX.length)))));
}
