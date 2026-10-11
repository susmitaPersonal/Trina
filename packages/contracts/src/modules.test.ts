/**
 * Module DSL, Milestone DSL, ModuleIntent, safety filter, signed confirmations and QR codes.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ActivityEvent,
  ChallengeDefinition,
  checkSafety,
  computeEventHash,
  ConfirmationBody,
  decodeQr,
  encodeQr,
  generateDeviceKeyPair,
  genesisHash,
  isMostlyEnglish,
  lowerOnly,
  MilestoneDefinition,
  ModuleDefinition,
  ModuleIntent,
  nameKey,
  PullChange,
  safetyReason,
  signConfirmation,
  uuidv7,
  verifyConfirmation,
  type ConfirmationClaim,
  type ModuleDefinitionInput,
} from './index';

export const kite: ModuleDefinitionInput = {
  schemaVersion: 'module/1.0',
  id: 'u_kite_flying_7f3a',
  version: 1,
  meta: { displayName: 'Kite flying', icon: 'kite', tags: ['social'] },
  movement: 'stationary_play',
  venue: 'open_ground',
  team: { min: 1, max: 20 },
  params: [{ key: 'targetMinutes', kind: 'int', min: 20, max: 180, default: 45, unit: 'minutes' }],
  counters: [{ id: 'duels_won', label: 'Kite duels won', unit: 'count', verification: 'peer', maxPerMinute: 0.3, maxPerSession: 20 }],
  taskTypes: [{ id: 'airborne', displayName: 'Get a kite in the air', completion: 'evidence', evidence: [{ kind: 'photo', count: 1, hint: 'Your kite' }], weight: 2 }],
  scoring: { counterRules: [{ counter: 'duels_won', weight: 1, capPerSession: 3 }], dwellWeight: 3 },
  difficulty: [{ param: 'targetMinutes', easy: 30, medium: 45, hard: 90 }],
  milestones: [{ id: 'in_field', title: 'In the field', window: 'session', measure: { agg: 'sum', fact: 'zone_dwell_s' }, tiers: [{ tier: 'bronze', gte: 1800 }, { tier: 'silver', gte: 2700 }], stat: 'SENSE' }],
};

describe('ModuleDefinition DSL', () => {
  it('parses a valid custom module and applies safe defaults', () => {
    const d = ModuleDefinition.parse(kite);
    expect(d.origin).toBe('community');
    expect(d.safety.daylightOnly).toBe(true);
    expect(d.meta.language).toBe('en');
  });

  it.each([
    ['unknown top-level key (closed vocabulary)', { points: 1000 }],
    ['motorised movement does not exist', { movement: 'car' }],
    ['rooftop venue does not exist', { venue: 'rooftop' }],
    ['a counter claiming sensor verification', { counters: [{ id: 'goals', label: 'Goals', unit: 'count', verification: 'sensor', maxPerMinute: 1, maxPerSession: 5 }] }],
    ['weight above 5', { taskTypes: [{ id: 'x', displayName: 'Thing', completion: 'self_report', weight: 9 }] }],
    ['evidence task without a photo', { taskTypes: [{ id: 'x', displayName: 'Thing', completion: 'evidence' }] }],
    ['community module that is not daylight-only', { safety: { daylightOnly: false } }],
    ['team.min > team.max', { team: { min: 5, max: 2 } }],
    ['duplicate counter ids', { counters: [kite.counters![0], kite.counters![0]] }],
    ['difficulty outside the param range', { difficulty: [{ param: 'targetMinutes', easy: 1, medium: 45, hard: 90 }] }],
    ['an expression string smuggled into scoring', { scoring: { counterRules: [], dwellWeight: 1, formula: 'points*1000' } }],
    ['a URL in the meta', { meta: { displayName: 'Kites', icon: 'kite', url: 'http://x' } }],
  ])('rejects %s', (_n, patch) => {
    expect(ModuleDefinition.safeParse({ ...kite, ...patch }).success).toBe(false);
  });
});

describe('Milestone DSL', () => {
  const base = { id: 'm1', title: 'Steps', window: 'day', measure: { agg: 'sum', fact: 'steps' }, tiers: [{ tier: 'bronze', gte: 2000 }], stat: 'VIT' };
  it('accepts bronze/silver/gold with increasing thresholds', () => {
    expect(MilestoneDefinition.safeParse({ ...base, tiers: [{ tier: 'bronze', gte: 1 }, { tier: 'silver', gte: 2 }, { tier: 'gold', gte: 3 }] }).success).toBe(true);
  });
  it.each([
    ['decreasing thresholds', { tiers: [{ tier: 'bronze', gte: 5 }, { tier: 'silver', gte: 2 }] }],
    ['wrong tier order', { tiers: [{ tier: 'gold', gte: 1 }, { tier: 'bronze', gte: 2 }] }],
    ['unlock mixed with tiers', { tiers: [{ tier: 'unlock', gte: 1 }, { tier: 'gold', gte: 2 }] }],
    ['a streak in a day window', { measure: { agg: 'streak_days', fact: 'steps', perDayGte: 10 } }],
    ['a string expression where', { where: 'steps > 5' }],
    ['unknown aggregator', { measure: { agg: 'avg', fact: 'steps' } }],
  ])('rejects %s', (_n, patch) => {
    expect(MilestoneDefinition.safeParse({ ...base, ...patch }).success).toBe(false);
  });
});

describe('ModuleIntent (the only thing the LLM may emit)', () => {
  const ok = { nameHint: 'Kite flying', movement: 'stationary_play', venue: 'open_ground', team: { size: 'small_group' } };
  it('accepts a minimal intent', () => {
    expect(ModuleIntent.parse(ok).sessionLength).toBe('medium');
  });
  it.each([
    ['points', { points: 1000 }],
    ['thresholds in milestone ideas', { milestoneIdeas: [{ label: 'Gold', basis: 'steps', window: 'day', gte: 1 }] }],
    ['sensor verification for a counter', { counters: [{ label: 'Goals', unit: 'count', verification: 'sensor' }] }],
    ['coordinates', { start: [88.3, 22.5] }],
    ['a module id', { id: 'walking' }],
    ['a motorised movement', { movement: 'car' }],
  ])('rejects %s', (_n, patch) => {
    expect(ModuleIntent.safeParse({ ...ok, ...patch }).success).toBe(false);
  });
});

describe('safety filter (deterministic, monotonic)', () => {
  it.each([
    ['drive fast around the city', 'blocked', 'motor_vehicle'],
    ['bike race on the highway', 'blocked', 'motor_vehicle'],
    ['rooftop kite flying', 'blocked', 'height'],
    ['ছাদে ঘুড়ি ওড়ানো', 'blocked', 'height'],
    ['छत पर पतंग', 'blocked', 'height'],
    ['walk on the railway tracks', 'blocked', 'rail'],
    ['firecracker contest', 'blocked', 'fire'],
    ['drinking game in the park', 'blocked', 'alcohol'],
    ['night run in the forest alone', 'blocked', 'night'],
    ['glass manja kite fights', 'blocked', 'sharp_string'],
    ['swim across the river', 'private_only', 'water'],
    ['kite flying in the field', 'note', 'sharp_string'],
    ['Trina Official Cricket', 'blocked', 'reserved_name'],
  ])('%s → %s', (text, level, category) => {
    const r = checkSafety([text]);
    expect(r.level).toBe(level);
    expect(r.findings.map((f) => f.category)).toContain(category);
  });

  it.each(['badminton in the park after college', 'bird walk at the lake at dawn', 'pick up plastic near the pond', 'gully cricket with friends', 'yoga in the garden', 'skating loop in the park', 'chess under the banyan tree'])(
    'leaves benign "%s" ok',
    (text) => {
      expect(['ok', 'note']).toContain(checkSafety([text]).level);
    },
  );

  it('kite flying gets safety notes that cannot be removed', () => {
    const r = checkSafety(['kite flying with friends']);
    expect(r.notes).toEqual(expect.arrayContaining(['no_glass_coated_string', 'stay_off_rooftops', 'away_from_power_lines']));
  });

  it('AI concerns can only make things stricter', () => {
    expect(checkSafety(['frisbee in the park'], ['height']).level).toBe('blocked');
    fc.assert(
      fc.property(fc.constantFrom('badminton', 'rooftop climbing', 'swim in the river', 'kite', 'walk'), fc.subarray(['height', 'water', 'heat', 'animals'] as const), (t, concerns) => {
        const rank = { ok: 0, note: 1, private_only: 2, blocked: 3 };
        expect(rank[checkSafety([t], [...concerns]).level]).toBeGreaterThanOrEqual(rank[checkSafety([t]).level]);
      }),
    );
  });

  it('gives a readable reason when refusing', () => {
    expect(safetyReason(checkSafety(['rooftop kite flying']))).toMatch(/fall risk/);
    expect(safetyReason(checkSafety(['walk in the park']))).toBeNull();
  });

  it('detects English-only input and normalises names', () => {
    expect(isMostlyEnglish('kite flying with friends')).toBe(true);
    expect(isMostlyEnglish('kal subah park mein frisbee')).toBe(true);
    expect(isMostlyEnglish('মাঠে বন্ধুদের সাথে ঘুড়ি ওড়াবো')).toBe(false);
    expect(isMostlyEnglish('पार्क में बैडमिंटन खेलेंगे')).toBe(false);
    expect(nameKey('Cricket!')).toBe(nameKey(' cricket'));
  });
});

describe('signed confirmations (ADR-026)', () => {
  const keys = generateDeviceKeyPair();
  const body = (claims: ConfirmationClaim[]) =>
    ConfirmationBody.parse({
      confirmationId: uuidv7(), challengeId: uuidv7(), subjectUserId: uuidv7(), subjectSessionId: uuidv7(),
      issuerUserId: uuidv7(), issuerDeviceId: uuidv7(), role: 'peer', claims,
    });

  it('verifies a genuine signature and rejects tampering, wrong keys and garbage', () => {
    const b = body([{ kind: 'counter', ref: 'cricket.catches', value: 1 }]);
    const sig = signConfirmation(b, keys.secretKeyHex);
    expect(verifyConfirmation(b, sig, keys.publicKeyHex)).toBe(true);
    expect(verifyConfirmation({ ...b, claims: [{ kind: 'counter', ref: 'cricket.catches', value: 5 }] }, sig, keys.publicKeyHex)).toBe(false);
    expect(verifyConfirmation(b, sig, generateDeviceKeyPair().publicKeyHex)).toBe(false);
    expect(verifyConfirmation(b, '00'.repeat(64), keys.publicKeyHex)).toBe(false);
  });

  it('property: any change to a signed body breaks the signature', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 499 }), fc.constantFrom('cricket.catches', 'football.goals', 't1'), (v, ref) => {
        const b = body([{ kind: ref.includes('.') ? 'counter' : 'task', ref, value: v }]);
        const sig = signConfirmation(b, keys.secretKeyHex);
        const changed = { ...b, claims: [{ ...b.claims[0]!, value: v + 1 }] };
        return verifyConfirmation(b, sig, keys.publicKeyHex) && !verifyConfirmation(changed, sig, keys.publicKeyHex);
      }),
      { numRuns: 25 },
    );
  });

  it('reviewers can only lower values, never raise them or add claims', () => {
    const req: ConfirmationClaim[] = [{ kind: 'counter', ref: 'cricket.overs_bowled', value: 2 }, { kind: 'counter', ref: 'cricket.catches', value: 1 }];
    const out = lowerOnly(req, [
      { kind: 'counter', ref: 'cricket.overs_bowled', value: 9 },
      { kind: 'counter', ref: 'football.goals', value: 3 },
    ]);
    expect(out).toEqual([{ kind: 'counter', ref: 'cricket.overs_bowled', value: 2 }]);
  });

  it('QR payloads round-trip (property) and stay ≤ 1 KB', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.record({ ref: fc.constantFrom('cricket.catches', 'football.goals', 'u_kite_flying_7f3a.duels_won', 'cricket.balls_faced', 'football.saves', 'u_kite_flying_7f3a_long_name.lines_cut_x'), value: fc.integer({ min: 1, max: 500 }) }), { minLength: 1, maxLength: 6, selector: (c) => c.ref }), fc.string({ maxLength: 40 }), (claims, name) => {
        const req = { t: 'req' as const, challengeId: uuidv7(), subjectUserId: uuidv7(), subjectSessionId: uuidv7(), subjectName: name, claims: claims.map((c) => ({ kind: 'counter' as const, ...c })) };
        const qr = encodeQr(req);
        expect(qr.length).toBeLessThanOrEqual(1024);
        expect(decodeQr(qr)).toEqual(req);
      }),
      { numRuns: 50 },
    );
    // Each counter/task once: a repeated claim would be summed twice by the engine.
    const dup = { t: 'req' as const, challengeId: uuidv7(), subjectUserId: uuidv7(), subjectSessionId: uuidv7(), subjectName: 'x', claims: [{ kind: 'counter' as const, ref: 'cricket.catches', value: 2 }, { kind: 'counter' as const, ref: 'cricket.catches', value: 2 }] };
    expect(() => encodeQr(dup)).not.toThrow(); // encoding doesn't validate; decoding does
    expect(() => decodeQr(encodeQr(dup))).toThrow();
    expect(() => decodeQr('https://evil.example')).toThrow();
    expect(() => decodeQr('TRINA1:!!!')).toThrow();
  });
});

describe('signed QR fits in 1 KB for every valid confirmation (6 claims, long refs, Bengali names)', () => {
  const ref = fc.tuple(fc.stringMatching(/^[a-z0-9_-]{1,32}$/), fc.option(fc.stringMatching(/^[a-z][a-z0-9_]{1,31}$/), { nil: undefined })).map(([a, b]) => (b ? `${a}.${b}` : a));
  const claims = fc.uniqueArray(fc.record({ kind: fc.constantFrom('counter' as const, 'task' as const), ref, value: fc.integer({ min: 1, max: 500 }) }), { minLength: 1, maxLength: 6, selector: (c) => `${c.kind}:${c.ref}` });
  const name = fc.oneof(fc.string({ maxLength: 40 }), fc.constant('অ'.repeat(40)), fc.constant('मीरा'.repeat(10)), fc.constant('😀'.repeat(20)));
  it('QR-B (signed token) round-trips, stays ≤ 1024 chars and the signature still verifies', () => {
    const k = generateDeviceKeyPair();
    fc.assert(
      fc.property(claims, name, fc.constantFrom('peer' as const, 'organizer' as const), (cs, issuerName, role) => {
        const body = ConfirmationBody.parse({ confirmationId: uuidv7(), challengeId: uuidv7(), subjectUserId: uuidv7(), subjectSessionId: uuidv7(), issuerUserId: uuidv7(), issuerDeviceId: uuidv7(), role, claims: cs });
        const tok = { t: 'tok' as const, body, issuerName, publicKey: k.publicKeyHex, sig: signConfirmation(body, k.secretKeyHex) };
        const qr = encodeQr(tok);
        expect(qr.length).toBeLessThanOrEqual(1024);
        const back = decodeQr(qr);
        expect(back).toEqual(tok);
        expect(back.t === 'tok' && verifyConfirmation(back.body, back.sig, back.publicKey)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
  it('QR-A (request) round-trips and stays ≤ 1024 chars', () => {
    fc.assert(
      fc.property(claims, name, (cs, subjectName) => {
        const req = { t: 'req' as const, challengeId: uuidv7(), subjectUserId: uuidv7(), subjectSessionId: uuidv7(), subjectName, claims: cs };
        const qr = encodeQr(req);
        expect(qr.length).toBeLessThanOrEqual(1024);
        expect(decodeQr(qr)).toEqual(req);
      }),
      { numRuns: 200 },
    );
  });
  it('rejects truncated, padded or tampered compact codes', () => {
    const req = { t: 'req' as const, challengeId: uuidv7(), subjectUserId: uuidv7(), subjectSessionId: uuidv7(), subjectName: 'A', claims: [{ kind: 'counter' as const, ref: 'cricket.catches', value: 2 }] };
    const qr = encodeQr(req);
    expect(() => decodeQr(qr.slice(0, -4))).toThrow();
    expect(() => decodeQr(qr + 'AAAA')).toThrow();
    expect(qr.startsWith('TRINA2:')).toBe(true);
    expect(() => decodeQr('TRINA2:CQ')).toThrow(); // unknown payload type
    // Every character matters: changing the last one never decodes to the same payload.
    for (const code of [qr, encodeQr({ ...req, subjectName: 'AB' }), encodeQr({ ...req, subjectName: 'ABC' })]) {
      const last = code[code.length - 1]!;
      const original = decodeQr(code);
      for (const c of 'ABCDEFGHQgw_') {
        if (c === last) continue;
        let same = false;
        try {
          same = JSON.stringify(decodeQr(code.slice(0, -1) + c)) === JSON.stringify(original);
        } catch {
          /* refused: fine */
        }
        expect(same).toBe(false);
      }
    }
    // Old JSON codes (v1) still decode; uppercase UUIDs fall back to v1 so the payload is kept exactly.
    const upper = { ...req, challengeId: req.challengeId.toUpperCase() };
    const v1 = encodeQr(upper);
    expect(v1.startsWith('TRINA1:')).toBe(true);
    expect(decodeQr(v1)).toEqual(upper);
  });
});

describe('events and DSL versions', () => {
  const seal = (type: string, payload: unknown) => {
    const sessionId = uuidv7();
    const base = { eventId: uuidv7(), sessionId, seq: 1, type, schemaVersion: 1, clientTs: new Date().toISOString(), monoMs: 0, payload, prevHash: genesisHash(sessionId) };
    return { ...base, hash: computeEventHash(base) };
  };
  it('parses the new event types', () => {
    for (const [type, payload] of [
      ['CountReported', { counterId: 'cricket.balls_faced', delta: 1 }],
      ['CountReported', { counterId: 'cricket.balls_faced', delta: -1 }],
      ['ConnectivityChanged', { online: false, transport: 'none' }],
      ['QuestStopped', { kind: 'safety', reason: 'weather' }],
    ] as const) {
      expect(ActivityEvent.safeParse(seal(type, payload)).success).toBe(true);
    }
    expect(ActivityEvent.safeParse(seal('CountReported', { counterId: 'cricket.balls_faced', delta: 0 })).success).toBe(false);
    expect(ActivityEvent.safeParse(seal('CountReported', { counterId: 'cricket.balls_faced', delta: 500 })).success).toBe(false);
  });

  it('accepts challenge DSL 1.0 and 1.1 (additive) with per_count rules', () => {
    const min = { meta: { title: 'Walk' }, modules: [{ id: 'walking', version: 1 }], participants: {}, timing: { durationMin: 30 }, area: { startZone: { type: 'circle', center: [88.35, 22.51], radiusM: 50 } }, route: {}, completion: {} };
    expect(ChallengeDefinition.safeParse({ ...min, schemaVersion: '1.0', scoring: {} }).success).toBe(true);
    expect(ChallengeDefinition.safeParse({ ...min, schemaVersion: '1.1', scoring: { rules: [{ id: 'c', kind: 'per_count', fact: 'cricket.catches.confirmed', pointsPer: 10, cap: 30 }] } }).success).toBe(true);
    expect(ChallengeDefinition.safeParse({ ...min, schemaVersion: '2.0', scoring: {} }).success).toBe(false);
  });

  it('pull changes include milestones, progress and module status', () => {
    const r = PullChange.safeParse({ kind: 'module_status', id: uuidv7(), data: { moduleId: 'u_x_abcd', status: 'taken_down' } });
    expect(r.success).toBe(true);
  });
});
