import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { Id, IsoDateTime, LngLat, Sha256Hex } from './common';
import { b64urlDecode, b64urlEncode, PublicKeyHex, SignatureHex, utf8Decode } from './confirmation';
import { canonicalJson, sha256Hex } from './hashing';

/**
 * Offline Party Mode (docs/architecture/offline-party-mode.md, ADR-033/034). Everything a party
 * exchanges travels as signed QR payloads between phones; no network. The host's invite carries
 * only PARAMETERS (never a full definition), so every phone rebuilds the identical definition with
 * the engine and compares hashes. Signatures reuse the Ed25519 device keys from ADR-026.
 */
export const PARTY_MIN_MEMBERS = 2;
export const PARTY_MAX_MEMBERS = 11;

export const PartyTemplateId = z.enum(['party_outside_v1', 'party_cleanup_v1', 'party_trees_v1']);
export type PartyTemplateId = z.infer<typeof PartyTemplateId>;

/** Themes the AI may pick (ADR-032). A theme changes words only, never numbers. */
export const ThemeId = z.enum(['tree_patrol', 'litter_hunters', 'river_guardians', 'park_explorers', 'mindful_wanderers', 'sunrise_squad']);
export type ThemeId = z.infer<typeof ThemeId>;

export const TargetMinutes = z.union([z.literal(30), z.literal(45), z.literal(60), z.literal(90)]);
export type TargetMinutes = z.infer<typeof TargetMinutes>;
export const LevelTier = z.enum(['easy', 'medium', 'hard']);
export type LevelTier = z.infer<typeof LevelTier>;

/** What the AI may emit for a quest or party mission: enums only, no numbers or places. */
export const QuestThemeIntent = z
  .object({
    themeId: ThemeId,
    tone: z.enum(['playful', 'calm', 'heroic']),
  })
  .strict();
export type QuestThemeIntent = z.infer<typeof QuestThemeIntent>;

export const PartySpec = z
  .object({ v: z.literal(1), templateId: PartyTemplateId, targetMinutes: TargetMinutes, levelTier: LevelTier, themeId: ThemeId.nullable() })
  .strict();
export type PartySpec = z.infer<typeof PartySpec>;

const Name = z.string().min(1).max(40);
const Nonce = z.string().regex(/^[0-9a-f]{16}$/);

export const PartyInviteBody = z
  .object({
    partyId: Id,
    spec: PartySpec,
    /** The host's own GPS fix (user location, never AI output), 6 decimal places. */
    startFix: LngLat,
    hostUserId: Id,
    hostDeviceId: Id,
    hostName: Name,
    hostPublicKey: PublicKeyHex,
    createdAt: IsoDateTime,
  })
  .strict();
export type PartyInviteBody = z.infer<typeof PartyInviteBody>;
export const PartyInvite = z.object({ t: z.literal('pinv'), body: PartyInviteBody, sig: SignatureHex }).strict();
export type PartyInvite = z.infer<typeof PartyInvite>;

/**
 * One side of a sighting handshake (ADR-034). A shows a token with a fresh nonce; B scans it, records a
 * PeerSighting and shows its own token with `replyTo` = A's nonce (so B's answer can't be replayed);
 * A scans that and records its PeerSighting. Each side's chain now holds the other's chain head.
 */
export const SightingBody = z
  .object({
    partyId: Id,
    userId: Id,
    deviceId: Id,
    sessionId: Id,
    name: Name,
    publicKey: PublicKeyHex,
    seq: z.int().min(1),
    chainHead: Sha256Hex,
    nonce: Nonce,
    replyTo: Nonce.nullable(),
  })
  .strict();
export type SightingBody = z.infer<typeof SightingBody>;
export const SightingToken = z.object({ t: z.literal('psig'), body: SightingBody, sig: SignatureHex }).strict();
export type SightingToken = z.infer<typeof SightingToken>;

/** A member's progress snapshot. Merged by highest `seq` per session (engine `mergeSummaries`). */
export const PartySummaryBody = z
  .object({
    partyId: Id,
    sessionId: Id,
    userId: Id,
    name: Name,
    seq: z.int().min(1),
    chainHead: Sha256Hex,
    goalValue: z.int().min(0).max(100_000),
    activeS: z.int().min(0).max(86_400),
    done: z.boolean(),
  })
  .strict();
export type PartySummaryBody = z.infer<typeof PartySummaryBody>;
export const PartySummary = z.object({ body: PartySummaryBody, publicKey: PublicKeyHex, sig: SignatureHex }).strict();
export type PartySummary = z.infer<typeof PartySummary>;
export const PartySummaryBundle = z.object({ t: z.literal('psum'), items: z.array(PartySummary).max(PARTY_MAX_MEMBERS) }).strict();
export type PartySummaryBundle = z.infer<typeof PartySummaryBundle>;

export type PartyQrPayload = PartyInvite | SightingToken | PartySummaryBundle;

/* ------------------------------ signatures ------------------------------ */

type Signed = { invite: PartyInviteBody; sighting: SightingBody; summary: PartySummaryBody };
const BODY_SCHEMAS = { invite: PartyInviteBody, sighting: SightingBody, summary: PartySummaryBody } as const;

/** Domain-separated, so a signature for one kind can never be accepted as another. */
export function partyMessage<K extends keyof Signed>(kind: K, body: Signed[K]): Uint8Array {
  return utf8ToBytes(`trina-party:v1:${kind}:${canonicalJson(BODY_SCHEMAS[kind].parse(body))}`);
}

export function signParty<K extends keyof Signed>(kind: K, body: Signed[K], secretKeyHex: string): string {
  return bytesToHex(ed25519.sign(partyMessage(kind, body), hexToBytes(secretKeyHex)));
}

export function verifyParty<K extends keyof Signed>(kind: K, body: Signed[K], sigHex: string, publicKeyHex: string): boolean {
  try {
    return ed25519.verify(hexToBytes(sigHex), partyMessage(kind, body), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

export const verifyInvite = (i: PartyInvite) => verifyParty('invite', i.body, i.sig, i.body.hostPublicKey);
export const verifySighting = (s: SightingToken) => verifyParty('sighting', s.body, s.sig, s.body.publicKey);
export const verifySummary = (s: PartySummary) => verifyParty('summary', s.body, s.sig, s.publicKey);

/** Identifies an invite (and so a party mission) on the server (parties.invite_hash). */
export function inviteHash(invite: PartyInvite): string {
  return sha256Hex(canonicalJson(PartyInvite.parse(invite)));
}

/** 64 bits of randomness as hex, for sighting nonces. */
export function newNonce(): string {
  return bytesToHex(randomBytes(8));
}

/* ------------------------------ check code ------------------------------ */

const WORDS = [
  'apple', 'bamboo', 'banyan', 'bee', 'berry', 'bird', 'breeze', 'brook', 'cedar', 'cloud', 'clover', 'coral', 'crow', 'daisy', 'dawn', 'deer',
  'dew', 'dune', 'eagle', 'fern', 'field', 'finch', 'fox', 'frog', 'grass', 'grove', 'hill', 'honey', 'ivy', 'jasmine', 'kite', 'lake',
  'leaf', 'lily', 'lotus', 'mango', 'maple', 'meadow', 'moon', 'moss', 'neem', 'oak', 'otter', 'owl', 'palm', 'path', 'pebble', 'pine',
  'pond', 'rain', 'reed', 'river', 'robin', 'rose', 'sand', 'seed', 'sky', 'sparrow', 'spring', 'star', 'stone', 'sun', 'tiger', 'willow',
] as const;

/** Four words from a definition hash, shown on every phone so players can confirm the mission by eye. */
export function checkCode(hashHex: string): string[] {
  const bits = parseInt(hashHex.slice(0, 6), 16); // 24 bits = 4 × 6
  return [18, 12, 6, 0].map((s) => WORDS[(bits >> s) & 63]!);
}

/* ------------------------------ QR (multi-frame) ------------------------------ */

/** Party payloads: base64url(format byte + data), split into frames "TRINAP1:<i>/<n>:<chunk>" of ≤ 800 chars. */
export const PARTY_QR_PREFIX = 'TRINAP1:';
export const PARTY_QR_FRAME_CHARS = 800;
const MAX_FRAMES = 6;

const parsePartyPayload = (raw: unknown): PartyQrPayload => {
  switch ((raw as { t?: string }).t) {
    case 'pinv':
      return PartyInvite.parse(raw);
    case 'psig':
      return SightingToken.parse(raw);
    case 'psum':
      return PartySummaryBundle.parse(raw);
    default:
      throw new Error('Not a Trina party code');
  }
};

/* Frame data = base64url(1 format byte + body). 1: canonical JSON. 2: compact summary bundle (raw UUID, key and
   signature bytes; the shared partyId once), about 250 bytes per member. */
const FMT_JSON = 1;
const FMT_SUMMARIES = 2;

const uuidBytes = (u: string) => hexToBytes(u.replace(/-/g, ''));
const bytesUuid = (b: Uint8Array) => {
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

function packSummaries(b: PartySummaryBundle): Uint8Array | null {
  const partyId = b.items[0]?.body.partyId;
  if (!partyId || b.items.some((x) => x.body.partyId !== partyId)) return null;
  const out: number[] = [FMT_SUMMARIES, b.items.length, ...uuidBytes(partyId)];
  const u32 = (n: number) => out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  for (const { body: x, publicKey, sig } of b.items) {
    out.push(...uuidBytes(x.sessionId), ...uuidBytes(x.userId));
    const name = utf8ToBytes(x.name);
    out.push(name.length, ...name);
    u32(x.seq);
    out.push(...hexToBytes(x.chainHead));
    u32(x.goalValue);
    u32(x.activeS);
    out.push(x.done ? 1 : 0, ...hexToBytes(publicKey), ...hexToBytes(sig));
  }
  return new Uint8Array(out);
}

function unpackSummaries(bytes: Uint8Array): unknown {
  let i = 1;
  const take = (n: number) => {
    if (i + n > bytes.length) throw new Error('Not a Trina party code');
    const b = bytes.subarray(i, i + n);
    i += n;
    return b;
  };
  const u32 = () => {
    const b = take(4);
    return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  };
  const count = take(1)[0]!;
  const partyId = bytesUuid(take(16));
  const items = Array.from({ length: count }, () => {
    const sessionId = bytesUuid(take(16));
    const userId = bytesUuid(take(16));
    const name = utf8Decode(take(take(1)[0]!));
    const seq = u32();
    const chainHead = bytesToHex(take(32));
    const goalValue = u32();
    const activeS = u32();
    const done = take(1)[0] === 1;
    return { body: { partyId, sessionId, userId, name, seq, chainHead, goalValue, activeS, done }, publicKey: bytesToHex(take(32)), sig: bytesToHex(take(64)) };
  });
  if (i !== bytes.length) throw new Error('Not a Trina party code');
  return { t: 'psum', items };
}

function decodeData(bytes: Uint8Array): PartyQrPayload {
  if (bytes[0] === FMT_JSON) return parsePartyPayload(JSON.parse(utf8Decode(bytes.subarray(1))));
  if (bytes[0] === FMT_SUMMARIES) return parsePartyPayload(unpackSummaries(bytes));
  throw new Error('Not a Trina party code');
}

export function encodePartyQr(payload: PartyQrPayload): string[] {
  const p = parsePartyPayload(payload);
  let bytes: Uint8Array | null = null;
  if (p.t === 'psum') {
    const packed = packSummaries(p);
    // Only when it decodes back to exactly the same payload, so a signature can never break.
    if (packed && canonicalJson(decodeData(packed)) === canonicalJson(p)) bytes = packed;
  }
  bytes ??= new Uint8Array([FMT_JSON, ...utf8ToBytes(canonicalJson(p))]);
  const data = b64urlEncode(bytes);
  const n = Math.max(1, Math.ceil(data.length / PARTY_QR_FRAME_CHARS));
  if (n > MAX_FRAMES) throw new Error('Party QR payload too large');
  return Array.from({ length: n }, (_, i) => `${PARTY_QR_PREFIX}${i + 1}/${n}:${data.slice(i * PARTY_QR_FRAME_CHARS, (i + 1) * PARTY_QR_FRAME_CHARS)}`);
}

export function isPartyQr(text: string): boolean {
  return text.startsWith(PARTY_QR_PREFIX);
}

/** Parses one scanned frame. */
export function readPartyFrame(text: string): { index: number; total: number; chunk: string } {
  const m = /^TRINAP1:(\d)\/(\d):([A-Za-z0-9_-]{1,800})$/.exec(text);
  if (!m) throw new Error('Not a Trina party code');
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (total < 1 || total > MAX_FRAMES || index < 1 || index > total) throw new Error('Not a Trina party code');
  return { index, total, chunk: m[3]! };
}

/**
 * Collects frames scanned in any order. Returns the payload once all frames are in, else null.
 * Frames from a different code (another total, or a decode failure) reset the collector.
 */
export class PartyQrCollector {
  private frames = new Map<number, string>();
  private total = 0;

  get progress(): { have: number; total: number } {
    return { have: this.frames.size, total: this.total };
  }

  add(text: string): PartyQrPayload | null {
    const f = readPartyFrame(text);
    if (f.total !== this.total) {
      this.frames.clear();
      this.total = f.total;
    }
    this.frames.set(f.index, f.chunk);
    if (this.frames.size < this.total) return null;
    const data = Array.from({ length: this.total }, (_, i) => this.frames.get(i + 1)!).join('');
    this.frames.clear();
    this.total = 0;
    return decodeData(b64urlDecode(data));
  }
}

export function decodePartyQr(frames: string[]): PartyQrPayload {
  const c = new PartyQrCollector();
  let out: PartyQrPayload | null = null;
  for (const f of frames) out = c.add(f) ?? out;
  if (!out) throw new Error('Incomplete party code');
  return out;
}
