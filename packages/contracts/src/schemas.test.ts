import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ActivityEvent,
  ChallengeDefinition,
  ChallengeIntent,
  ConditionSchema,
  EVENT_TYPES,
  IntentPatch,
  LoginRequest,
  PushRequest,
  PullResponse,
  canonicalJson,
  computeEventHash,
  genesisHash,
  uuidv7,
} from './index';

const minimal = {
  schemaVersion: '1.0',
  meta: { title: 'Walk' },
  modules: [{ id: 'walking', version: 1 }],
  participants: {},
  timing: { durationMin: 30 },
  area: { startZone: { type: 'circle', center: [88.35, 22.51], radiusM: 50 } },
  route: {},
  scoring: {},
  completion: {},
};

describe('ChallengeDefinition schema', () => {
  it('applies defaults to a minimal definition', () => {
    const d = ChallengeDefinition.parse(minimal);
    expect(d.meta.visibility).toBe('public');
    expect(d.mode).toBe('individual');
    expect(d.checkpoints).toEqual([]);
    expect(d.safety.noSpeedRewards).toBe(true);
  });
  it.each([
    ['bad coordinates', { area: { startZone: { type: 'circle', center: [200, 95], radiusM: 50 } } }],
    ['duration too long', { timing: { durationMin: 10_000 } }],
    ['wrong schema version', { schemaVersion: '9.9' }],
    ['speed reward allowed', { safety: { noSpeedRewards: false } }],
    ['no modules', { modules: [] }],
    ['bad module id', { modules: [{ id: 'Walking!', version: 1 }] }],
    ['bad task type', { tasks: [{ id: 't', type: 'notdotted' }] }],
  ])('rejects %s', (_label, patch) => {
    expect(ChallengeDefinition.safeParse({ ...minimal, ...patch }).success).toBe(false);
  });
  it('accepts nested condition ASTs and rejects code strings', () => {
    expect(ConditionSchema.safeParse({ all: [{ fact: 'completed', op: '==', value: true }, { not: { any: [{ fact: 'distance_m', op: '>', value: 5 }] } }] }).success).toBe(true);
    expect(ConditionSchema.safeParse('process.exit()').success).toBe(false);
    expect(ConditionSchema.safeParse({ fact: 'x', op: '=~', value: 1 }).success).toBe(false);
  });
});

describe('events', () => {
  it('has a schema for every event type and rejects unknown types', () => {
    expect(EVENT_TYPES.length).toBeGreaterThanOrEqual(22);
    const base = { eventId: uuidv7(), sessionId: uuidv7(), seq: 1, schemaVersion: 1, clientTs: new Date().toISOString(), monoMs: 0, prevHash: 'a'.repeat(64), hash: 'b'.repeat(64) };
    expect(ActivityEvent.safeParse({ ...base, type: 'GpsSignalLost', payload: {} }).success).toBe(true);
    expect(ActivityEvent.safeParse({ ...base, type: 'Teleported', payload: {} }).success).toBe(false);
    expect(ActivityEvent.safeParse({ ...base, type: 'GpsSignalLost', payload: {}, seq: 0 }).success).toBe(false);
    expect(ActivityEvent.safeParse({ ...base, type: 'StepsSample', payload: { cumulative: 1, delta: 1_000_000, source: 'simulated' } }).success).toBe(false);
    expect(ActivityEvent.safeParse({ ...base, type: 'LocationBatch', payload: { samples: [] } }).success).toBe(false);
  });
  it('genesis hash is per session', () => {
    expect(genesisHash(uuidv7())).not.toBe(genesisHash(uuidv7()));
  });
  it('canonicalJson round-trips arbitrary JSON values (property)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const s = canonicalJson(v);
        expect(canonicalJson(JSON.parse(s))).toBe(s);
      }),
    );
  });
  it('hash changes when payload changes (property)', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.integer()), fc.dictionary(fc.string(), fc.integer()), (a, b) => {
        fc.pre(canonicalJson(a) !== canonicalJson(b));
        const e = { eventId: 'e', sessionId: 's', seq: 1, type: 'T', schemaVersion: 1, clientTs: 't', monoMs: 0, prevHash: 'p' };
        expect(computeEventHash({ ...e, payload: a })).not.toBe(computeEventHash({ ...e, payload: b }));
      }),
    );
  });
});

describe('sync + api schemas', () => {
  it('push requires protocol v1 and bounded batches', () => {
    const ok = { protocolVersion: 1, deviceId: uuidv7(), batchId: uuidv7(), sessions: [{ sessionId: uuidv7(), events: [] }] };
    expect(PushRequest.safeParse(ok).success).toBe(true);
    expect(PushRequest.safeParse({ ...ok, protocolVersion: 2 }).success).toBe(false);
    expect(PushRequest.safeParse({ ...ok, sessions: [] }).success).toBe(false);
    expect(PushRequest.safeParse({ ...ok, sessions: [{ sessionId: uuidv7(), events: Array(501).fill({}) }] }).success).toBe(false);
  });
  it('pull only accepts known change kinds', () => {
    expect(PullResponse.safeParse({ changes: [{ kind: 'nuke', id: uuidv7(), data: {} }], cursor: '0', serverTime: new Date().toISOString() }).success).toBe(false);
  });
  it('login trims + lowercases email and requires a device', () => {
    expect(LoginRequest.parse({ email: ' A@B.dev ', password: 'x', device: { id: uuidv7(), platform: 'android', appVersion: '1' } }).email).toBe('a@b.dev');
    expect(LoginRequest.safeParse({ email: 'a@b.dev', password: 'x' }).success).toBe(false);
  });
  it('intent patches only touch whitelisted paths', () => {
    expect(IntentPatch.safeParse({ ops: [{ op: 'set', path: 'durationMin', value: 30 }] }).success).toBe(true);
    expect(IntentPatch.safeParse({ ops: [{ op: 'set', path: 'scoring.rules', value: [] }] }).success).toBe(false);
  });
  it('intent rejects absurd values', () => {
    const base = { durationMin: 60, participants: { count: 4, mode: 'team' }, activities: [{ module: 'walking' }], checkpoints: { count: 4 } };
    expect(ChallengeIntent.safeParse(base).success).toBe(true);
    expect(ChallengeIntent.safeParse({ ...base, durationMin: 100_000 }).success).toBe(false);
    expect(ChallengeIntent.safeParse({ ...base, activities: [] }).success).toBe(false);
    expect(ChallengeIntent.safeParse({ ...base, unresolved: ['launch_codes'] }).success).toBe(false);
  });
});
