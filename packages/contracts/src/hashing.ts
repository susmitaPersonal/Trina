import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Deterministic JSON: object keys sorted, no whitespace, `undefined` properties dropped.
 * Used for event hashes and definition hashes, so device and server always agree.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function sha256Hex(input: string | Uint8Array): string {
  return bytesToHex(sha256(typeof input === 'string' ? utf8ToBytes(input) : input));
}

/** prevHash of the first event (seq 1) of a session. */
export function genesisHash(sessionId: string): string {
  return sha256Hex(`trina-session:${sessionId}`);
}

export type HashableEvent = {
  eventId: string;
  sessionId: string;
  seq: number;
  type: string;
  schemaVersion: number;
  clientTs: string;
  monoMs: number;
  payload: unknown;
  prevHash: string;
};

/** hash = SHA-256(canonicalJson(event without `hash`)). `prevHash` is included, forming a chain. */
export function computeEventHash(e: HashableEvent): string {
  const { eventId, sessionId, seq, type, schemaVersion, clientTs, monoMs, payload, prevHash } = e;
  return sha256Hex(canonicalJson({ eventId, sessionId, seq, type, schemaVersion, clientTs, monoMs, payload, prevHash }));
}

export function definitionHash(definition: unknown): string {
  return sha256Hex(canonicalJson(definition));
}

/** Verifies a contiguous, seq-ordered list of events. Returns the first broken seq, or null. */
export function verifyChain(
  sessionId: string,
  events: Array<HashableEvent & { hash: string }>,
  startPrevHash?: string,
): { ok: true } | { ok: false; seq: number; reason: 'prev_hash' | 'hash' } {
  let prev = startPrevHash ?? genesisHash(sessionId);
  for (const e of events) {
    if (e.prevHash !== prev) return { ok: false, seq: e.seq, reason: 'prev_hash' };
    if (computeEventHash(e) !== e.hash) return { ok: false, seq: e.seq, reason: 'hash' };
    prev = e.hash;
  }
  return { ok: true };
}
