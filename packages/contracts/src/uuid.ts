import { randomBytes } from '@noble/hashes/utils.js';

/**
 * RFC 9562 UUIDv7: 48-bit unix ms timestamp + random. Time-sortable, globally unique.
 * Requires `crypto.getRandomValues` (React Native: import 'react-native-get-random-values' first).
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const b = randomBytes(16);
  const ts = BigInt(nowMs);
  b[0] = Number((ts >> 40n) & 0xffn);
  b[1] = Number((ts >> 32n) & 0xffn);
  b[2] = Number((ts >> 24n) & 0xffn);
  b[3] = Number((ts >> 16n) & 0xffn);
  b[4] = Number((ts >> 8n) & 0xffn);
  b[5] = Number(ts & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70; // version 7
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
