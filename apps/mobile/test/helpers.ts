import { mkdtempSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { bearingDeg, destinationPoint, haversineM } from '@trina/engine';
import type { LngLat } from '@trina/contracts';
import type { BinaryUploader, TokenStore } from '../src/core/api-client';
import type { Clock } from '../src/core/clock';
import type { RawFix, SessionManager } from '../src/core/session-manager';

export class FakeClock implements Clock {
  private perf = 1000;
  constructor(public wall: number) {}
  wallNow() {
    return this.wall;
  }
  perfNow() {
    return this.perf;
  }
  advance(ms: number) {
    this.wall += ms;
    this.perf += ms;
  }
}

export function memoryTokens(): TokenStore & { tokens: { accessToken: string | null; refreshToken: string | null } } {
  const s = {
    tokens: { accessToken: null as string | null, refreshToken: null as string | null },
    async get() {
      return s.tokens;
    },
    async set(t: { accessToken: string; refreshToken: string } | null) {
      s.tokens = t ?? { accessToken: null, refreshToken: null };
    },
  };
  return s;
}

/** Network switch + "lost response" injection around real fetch. */
export function flakyFetch() {
  const ctl = { online: true, dropNextResponse: false, calls: 0 };
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    ctl.calls++;
    if (!ctl.online) throw new TypeError('Network request failed');
    const res = await fetch(url, init);
    if (ctl.dropNextResponse && String(url).includes('/sync/push')) {
      ctl.dropNextResponse = false;
      await res.arrayBuffer();
      throw new TypeError('Network request failed (response lost)');
    }
    return res;
  }) as typeof fetch;
  return { fetch: f, ctl };
}

export function fsUploader(fetchImpl: typeof fetch): BinaryUploader {
  return async ({ url, fileUri, headers }) => {
    const body = await readFile(fileUri);
    const res = await fetchImpl(url, { method: 'PUT', headers, body });
    return { status: res.status, body: await res.text() };
  };
}

export const tmp = () => mkdtempSync(join(tmpdir(), 'trina-mobile-'));

export async function writePhoto(dir: string, name: string, bytes: Buffer) {
  const uri = join(dir, `${name}.jpg`);
  await writeFile(uri, bytes);
  return { uri, sha256: bytesToHex(sha256(bytes)), bytes: bytes.length };
}

/** Walks from the current position to `to`, feeding GPS fixes through the real SessionManager path. */
export async function walk(sm: SessionManager, sessionId: string, clock: FakeClock, from: LngLat, to: LngLat, speed = 1.4, intervalS = 5): Promise<LngLat> {
  const total = haversineM(from, to);
  const brg = bearingDeg(from, to);
  let d = 0;
  const fixes: RawFix[] = [];
  while (d + speed * intervalS < total) {
    d += speed * intervalS;
    clock.advance(intervalS * 1000);
    const [lng, lat] = destinationPoint(from, brg, d);
    fixes.push({ lat, lng, acc: 8, timestamp: clock.wallNow() });
    if (fixes.length >= 10) await sm.addFixes(sessionId, fixes.splice(0));
  }
  clock.advance(Math.max(1000, Math.round(((total - d) / speed) * 1000)));
  fixes.push({ lat: to[1], lng: to[0], acc: 8, timestamp: clock.wallNow() });
  await sm.addFixes(sessionId, fixes);
  return to;
}

export async function stay(sm: SessionManager, sessionId: string, clock: FakeClock, at: LngLat, seconds: number, intervalS = 5) {
  const fixes: RawFix[] = [];
  for (let s = 0; s < seconds; s += intervalS) {
    clock.advance(intervalS * 1000);
    fixes.push({ lat: at[1], lng: at[0], acc: 8, timestamp: clock.wallNow() });
  }
  await sm.addFixes(sessionId, fixes);
}
