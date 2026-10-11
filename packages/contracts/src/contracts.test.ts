import { describe, expect, it } from 'vitest';
import {
  ActivityEvent,
  canonicalJson,
  computeEventHash,
  genesisHash,
  uuidv7,
  verifyChain,
  ChallengeIntent,
  RegisterRequest,
} from './index';

describe('canonicalJson', () => {
  it('sorts keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: undefined }, z: null })).toBe('{"a":{"d":[1,2]},"b":1,"z":null}');
  });
  it('is stable regardless of insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });
  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
});

describe('uuidv7', () => {
  it('produces valid, time-sortable v7 ids', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe('event hash chain', () => {
  const sessionId = uuidv7();
  const mk = (seq: number, prevHash: string) => {
    const base = {
      eventId: uuidv7(),
      sessionId,
      seq,
      type: 'TaskStarted' as const,
      schemaVersion: 1,
      clientTs: '2026-10-20T08:00:00.000Z',
      monoMs: seq * 1000,
      payload: { taskId: 't1' },
      prevHash,
    };
    return { ...base, hash: computeEventHash(base) };
  };

  it('verifies an intact chain and detects tampering', () => {
    const e1 = mk(1, genesisHash(sessionId));
    const e2 = mk(2, e1.hash);
    expect(verifyChain(sessionId, [e1, e2])).toEqual({ ok: true });
    const tampered = { ...e2, payload: { taskId: 't2' } };
    expect(verifyChain(sessionId, [e1, tampered])).toEqual({ ok: false, seq: 2, reason: 'hash' });
    expect(ActivityEvent.safeParse(e1).success).toBe(true);
  });
});

describe('schemas', () => {
  it('applies intent defaults', () => {
    const i = ChallengeIntent.parse({
      durationMin: 60,
      participants: { count: 4, mode: 'team' },
      activities: [{ module: 'walking' }],
      checkpoints: { count: 4 },
    });
    expect(i.difficulty).toBe('medium');
    expect(i.checkpoints.layout).toBe('loop');
  });
  it('normalises register email', () => {
    const r = RegisterRequest.parse({
      email: ' Priya@Example.COM',
      password: 'correct horse battery',
      displayName: 'Priya',
      ageConfirmed: true,
      device: { id: uuidv7(), platform: 'test', appVersion: '0.1.0' },
    });
    expect(r.email).toBe('priya@example.com');
  });
});
