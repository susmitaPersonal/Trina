import { createHash } from 'node:crypto';
import { computeEventHash, definitionHash, uuidv7, type ActivityEvent } from '@trina/contracts';
import { compileOrThrow, destinationPoint } from '@trina/engine';
import { SessionBuilder, greenSprintCleanRun, greenSprintDefinition, greenSprintPoints } from '@trina/engine/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jpeg, setup, type TestUser } from './helpers';

let t: Awaited<ReturnType<typeof setup>>;
let owner: TestUser;
let challengeId: string;
const defHash = definitionHash(compileOrThrow(greenSprintDefinition()).definition);

beforeAll(async () => {
  t = await setup();
  owner = await t.user('organizer');
  challengeId = await t.publishedChallenge(owner);
});
afterAll(async () => {
  await t.cleanup();
});

const twoHoursAgo = () => new Date(Date.now() - 2 * 3_600_000).toISOString();
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function joined(name: string) {
  const u = await t.user(name);
  await t.api.post(`/v1/challenges/${challengeId}/join`).set(u.auth).send({}).expect(201);
  await t.api.post('/v1/me').set(u.auth); // no-op
  return u;
}

function push(u: TestUser, sessionId: string, events: ActivityEvent[], batchId = uuidv7()) {
  return t.api.post('/v1/sync/push').set(u.auth).send({ protocolVersion: 1, deviceId: u.deviceId, batchId, sessions: [{ sessionId, events }] });
}

/** Builds a clean Green Sprint run with REAL photo hashes so uploads match. */
async function cleanRunWithPhotos(u: TestUser, seed: number) {
  const photos = { litter: await jpeg(seed), tree1: await jpeg(seed + 1), tree2: await jpeg(seed + 2) };
  const run = greenSprintCleanRun({ challengeId, definitionHash: defHash, userId: u.user.id, deviceId: u.deviceId, startTs: twoHoursAgo() });
  // Re-seal the chain with the real photo hashes.
  const map: Record<string, string> = { [run.shas.litter]: sha(photos.litter), [run.shas.tree1]: sha(photos.tree1), [run.shas.tree2]: sha(photos.tree2) };
  let prev = run.events[0]!.prevHash;
  const events = run.events.map((e) => {
    const payload = e.type === 'EvidenceCaptured' ? { ...e.payload, sha256: map[e.payload.sha256] ?? e.payload.sha256 } : e.payload;
    const base = { ...e, payload, prevHash: prev } as ActivityEvent;
    const hash = computeEventHash(base);
    prev = hash;
    return { ...base, hash } as ActivityEvent;
  });
  return { ...run, events, photos };
}

describe('offline session → sync → validation → leaderboard', () => {
  it('handles duplicates, partial batches, evidence and produces a verified final score', async () => {
    const u = await joined('arjun');
    await t.api.patch('/v1/me').set(u.auth).send({ shareWellbeing: true });
    const run = await cleanRunWithPhotos(u, 10);
    const half = Math.ceil(run.events.length / 2);

    // Second half first (out of order): server must not ack past the gap.
    const early = await push(u, run.sessionId, run.events.slice(half));
    expect(early.body.results[0].rejected[0].code).toBe('SESSION_UNKNOWN');

    const first = await push(u, run.sessionId, run.events.slice(0, half));
    expect(first.status).toBe(200);
    expect(first.body.results[0].ackedThroughSeq).toBe(half);

    // Lost response → client retries the same batch: everything is a duplicate, nothing changes.
    const retry = await push(u, run.sessionId, run.events.slice(0, half));
    expect(retry.body.results[0].duplicates).toBe(half);
    expect(retry.body.results[0].accepted).toBe(0);

    const second = await push(u, run.sessionId, run.events.slice(half));
    const res = second.body.results[0];
    expect(res.ackedThroughSeq).toBe(run.events.length);
    expect(res.evidenceNeeded.sort()).toEqual(Object.values(run.evidence).sort());

    // Not validated yet: photos missing.
    expect(await t.ctx.jobs.drain()).toBe(0);

    // Upload: wrong type, wrong bytes, then correct (twice → idempotent).
    const bad = await t.api.put(`/v1/evidence/${run.evidence.litter}/content`).set(u.auth).set('Content-Type', 'image/jpeg').send(Buffer.from('GIF89a not a jpeg'));
    expect(bad.status).toBe(415);
    const wrong = await t.api.put(`/v1/evidence/${run.evidence.litter}/content`).set(u.auth).set('Content-Type', 'image/jpeg').send(run.photos.tree1);
    expect(wrong.status).toBe(409);
    for (const k of ['litter', 'tree1', 'tree2'] as const) {
      const up = await t.api.put(`/v1/evidence/${run.evidence[k]}/content`).set(u.auth).set('Content-Type', 'image/jpeg').set('X-Content-SHA256', sha(run.photos[k])).send(run.photos[k]);
      expect(up.status).toBe(201);
    }
    const again = await t.api.put(`/v1/evidence/${run.evidence.litter}/content`).set(u.auth).set('Content-Type', 'image/jpeg').send(run.photos.litter);
    expect(again.status).toBe(200);

    expect(await t.ctx.jobs.drain()).toBeGreaterThanOrEqual(1);

    const s = await t.api.get(`/v1/sessions/${run.sessionId}`).set(u.auth);
    expect(s.status).toBe(200);
    // The wrong-bytes upload attempt is recorded as an anomaly → honest flag, needs human review.
    expect(s.body.flags.map((f: any) => f.code)).toContain('EVIDENCE_HASH_MISMATCH');
    expect(s.body.verdict).toBe('needs_review');
    expect(s.body.score.totalPoints).toBe(281);
    expect(s.body.score.completed).toBe(true);
    expect(s.body.wellness.steps).toBeGreaterThan(2000);
    expect(s.body.wellness.moodBefore).toBe(3);
    expect(s.body.wellness.moodAfter).toBe(5);
    expect(s.body.wellness.phoneFreeMinutes).toBe(10);

    // Hidden while under review; admin approves → ranked.
    let lb = await t.api.get(`/v1/challenges/${challengeId}/leaderboard`).set(u.auth);
    expect(lb.body.entries.find((e: any) => e.subjectId === u.user.id)).toBeFalsy();
    expect(lb.body.pending).toBeGreaterThanOrEqual(1);
    const admin = await t.user('admin', 'admin');
    const flags = await t.api.get('/v1/admin/flags').set(admin.auth);
    expect(flags.body.items.some((i: any) => i.session_id === run.sessionId)).toBe(true);
    expect((await t.api.get('/v1/admin/flags').set(u.auth)).status).toBe(403);
    await t.api.post(`/v1/admin/sessions/${run.sessionId}/review`).set(admin.auth).send({ decision: 'approve', note: 'Retry was an honest app bug' }).expect(200);
    lb = await t.api.get(`/v1/challenges/${challengeId}/leaderboard`).set(u.auth);
    expect(lb.body.entries[0]).toMatchObject({ rank: 1, points: 281, verification: 'verified' });

    // Pull delivers results to the device.
    const pull = await t.api.get('/v1/sync/pull?cursor=0').set(u.auth);
    const results = pull.body.changes.filter((c: any) => c.kind === 'session_result');
    expect(results.at(-1).data.verdict).toBe('verified');
    const pull2 = await t.api.get(`/v1/sync/pull?cursor=${pull.body.cursor}`).set(u.auth);
    expect(pull2.body.changes).toHaveLength(0);

    // Evidence links are signed and short-lived.
    const ev = await t.api.get(`/v1/evidence/${run.evidence.litter}`).set(u.auth);
    const url = new URL(ev.body.url);
    const img = await t.api.get(url.pathname + url.search);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect((await t.api.get(url.pathname + url.search.replace(/sig=[^&]+/, 'sig=forged'))).status).toBe(403);
    const stranger = await t.user();
    expect((await t.api.get(`/v1/evidence/${run.evidence.litter}`).set(stranger.auth)).status).toBe(404);
  });

  it('a clean upload flow is fully verified, and the organiser gets an impact report', async () => {
    const u = await joined('meera');
    const run = await cleanRunWithPhotos(u, 50);
    await push(u, run.sessionId, run.events).expect(200);
    for (const k of ['litter', 'tree1', 'tree2'] as const) {
      await t.api.put(`/v1/evidence/${run.evidence[k]}/content`).set(u.auth).set('Content-Type', 'image/jpeg').send(run.photos[k]).expect(201);
    }
    await t.ctx.jobs.drain();
    const s = await t.api.get(`/v1/sessions/${run.sessionId}`).set(u.auth);
    expect(s.body.flags).toEqual([]);
    expect(s.body.verdict).toBe('verified');
    // Mood not shared (user did not opt in).
    expect(s.body.wellness.moodBefore ?? null).toBeNull();

    const impact = await t.api.get(`/v1/challenges/${challengeId}/impact`).set(owner.auth);
    expect(impact.body.verifiedSessions).toBeGreaterThanOrEqual(2);
    expect(impact.body.tasks.litter).toBeGreaterThanOrEqual(2);
    expect(impact.body.avgMoodDelta).toBeNull(); // fewer than 5 opted-in participants
    const csv = await t.api.get(`/v1/challenges/${challengeId}/impact?format=csv`).set(owner.auth);
    expect(csv.text).toMatch(/^metric,value/);
    expect((await t.api.get(`/v1/challenges/${challengeId}/impact`).set(u.auth)).status).toBe(403);

    const recap = await t.api.post('/v1/ai/recaps').set(u.auth).send({ sessionId: run.sessionId });
    expect(recap.body.text).toMatch(/Green Sprint 60/);
  });
});

describe('anti-cheat (flags, not accusations)', () => {
  it('flags mock locations, teleports and reused photos → needs_review, hidden from leaderboard', async () => {
    const honest = await joined('honest');
    const honestRun = await cleanRunWithPhotos(honest, 70);
    await push(honest, honestRun.sessionId, honestRun.events).expect(200);
    for (const k of ['litter', 'tree1', 'tree2'] as const) {
      await t.api.put(`/v1/evidence/${honestRun.evidence[k]}/content`).set(honest.auth).set('Content-Type', 'image/jpeg').send(honestRun.photos[k]);
    }
    await t.ctx.jobs.drain();

    const cheat = await joined('cheat');
    const p = greenSprintPoints();
    const evId = uuidv7();
    const b = new SessionBuilder({ challengeId, definitionHash: defHash, userId: cheat.user.id, deviceId: cheat.deviceId, start: p.start, startTs: twoHoursAgo() });
    b.start()
      .teleport(p.cp1, { mocked: true })
      .wait(20, 5, { mocked: true })
      .teleport(destinationPoint(p.start, 0, 2000))
      .moveTo(p.cp1)
      .wait(20)
      .moveTo(p.cp2)
      .wait(30)
      .evidence('litter', sha(honestRun.photos.litter), evId, 'cp2') // someone else's photo
      .completeTask('litter')
      .complete();
    const events = b.build();
    await push(cheat, b.sessionId, events).expect(200);
    await t.api.put(`/v1/evidence/${evId}/content`).set(cheat.auth).set('Content-Type', 'image/jpeg').send(honestRun.photos.litter).expect(201);
    await t.ctx.jobs.drain();

    const s = await t.api.get(`/v1/sessions/${b.sessionId}`).set(cheat.auth);
    const codes = s.body.flags.map((f: any) => f.code);
    expect(codes).toContain('MOCK_LOCATION');
    expect(codes).toContain('EVIDENCE_DUPLICATE');
    expect(s.body.verdict).toBe('needs_review');
    expect(s.body.flags.every((f: any) => !/cheat/i.test(f.message))).toBe(true);
    const litter = s.body.score.breakdown.find((x: any) => x.ruleId === 'litter');
    expect(litter.status).toBe('invalidated');
    const lb = await t.api.get(`/v1/challenges/${challengeId}/leaderboard`).set(cheat.auth);
    expect(lb.body.entries.find((e: any) => e.subjectId === cheat.user.id)).toBeFalsy();
  });

  it('detects tampering with stored events (hash chain) and rejects foreign sessions', async () => {
    const u = await joined('tamper');
    const p = greenSprintPoints();
    const b = new SessionBuilder({ challengeId, definitionHash: defHash, userId: u.user.id, deviceId: u.deviceId, start: p.start, startTs: twoHoursAgo() });
    b.start().moveTo(p.cp1).wait(20).complete();
    const events = b.build();
    // Edit a payload after sealing (e.g. someone modified the SQLite file) but keep the old hash.
    const tampered = events.map((e) => (e.type === 'SessionCompleted' ? { ...e, payload: { ...e.payload, provisionalScore: 9999 } } : e));
    await push(u, b.sessionId, tampered).expect(200);
    await t.ctx.jobs.drain();
    const s = await t.api.get(`/v1/sessions/${b.sessionId}`).set(u.auth);
    expect(s.body.flags.map((f: any) => f.code)).toContain('CHAIN_BROKEN');

    // Another user cannot push into or read this session.
    const other = await joined('intruder');
    const r = await push(other, b.sessionId, events);
    expect(r.body.results[0].rejected.every((x: any) => x.code === 'FORBIDDEN')).toBe(true);
    expect((await t.api.get(`/v1/sessions/${b.sessionId}`).set(other.auth)).status).toBe(403);
  });

  it('rejects sessions from non-participants and malformed events individually', async () => {
    const u = await t.user('outsider');
    const b = new SessionBuilder({ challengeId, definitionHash: defHash, userId: u.user.id, deviceId: u.deviceId, start: greenSprintPoints().start, startTs: twoHoursAgo() });
    b.start();
    const r = await push(u, b.sessionId, [...b.build(), { eventId: 'garbage' } as any]);
    const rej = r.body.results[0].rejected;
    expect(rej.find((x: any) => x.eventId === 'garbage').code).toBe('SCHEMA_INVALID');
    expect(rej.some((x: any) => x.code === 'NOT_PARTICIPANT')).toBe(true);
  });
});
