/**
 * Route coverage: every endpoint not exercised by the flow tests, incl. authorization,
 * privacy controls, retention, rate limits and HTTP edge cases.
 */
import { uuidv7 } from '@trina/contracts';
import { greenSprintDefinition } from '@trina/engine/fixtures';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMaintenance } from '../src/modules/validation/jobs';
import { jpeg, playCleanRun, setup, type TestUser } from './helpers';

let t: Awaited<ReturnType<typeof setup>>;
let owner: TestUser;
let challengeId: string;
beforeAll(async () => {
  t = await setup();
  owner = await t.user('owner');
  challengeId = await t.publishedChallenge(owner);
});
afterAll(async () => {
  await t.cleanup();
});

async function joined(name?: string) {
  const u = await t.user(name);
  await t.api.post(`/v1/challenges/${challengeId}/join`).set(u.auth).send({}).expect(201);
  return u;
}

describe('HTTP edge cases', () => {
  it('malformed JSON → 400 problem+json; oversized → 413', async () => {
    const u = await t.user();
    const bad = await t.api.post('/v1/sync/push').set(u.auth).set('Content-Type', 'application/json').send('{"oops":');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    const big = await t.api.post('/v1/sync/push').set(u.auth).send({ junk: 'x'.repeat(600_000) });
    expect(big.status).toBe(413);
    expect(big.body.code).toBe('PAYLOAD_TOO_LARGE');
  });
  it('invalid UUID params → 400, unknown resources → 404', async () => {
    const u = await t.user();
    expect((await t.api.get('/v1/challenges/not-a-uuid').set(u.auth)).status).toBe(400);
    expect((await t.api.get(`/v1/challenges/${uuidv7()}`).set(u.auth)).status).toBe(404);
    expect((await t.api.get(`/v1/sessions/${uuidv7()}`).set(u.auth)).status).toBe(403);
  });
  it('sets security headers and request ids', async () => {
    const r = await t.api.get('/v1/health');
    expect(r.headers['x-request-id']).toBeTruthy();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
});

describe('/me', () => {
  it('lists my sessions and wellness totals; mood trend only when opted in', async () => {
    const u = await joined('wellness');
    await playCleanRun(t, u, challengeId, 200);
    const sessions = await t.api.get('/v1/me/sessions').set(u.auth);
    expect(sessions.body.items).toHaveLength(1);
    expect(sessions.body.items[0].verdict).toBe('verified');
    let w = await t.api.get('/v1/me/wellness?period=all').set(u.auth);
    expect(w.body.totals.sessions).toBe(1);
    expect(w.body.totals.steps).toBeGreaterThan(1000);
    expect(w.body.moodTrend).toBeUndefined();
    await t.api.patch('/v1/me').set(u.auth).send({ shareWellbeing: true });
    await t.api.put(`/v1/sessions/${sessions.body.items[0].id}/mood`).set(u.auth).send({ moodBefore: 2, moodAfter: 4 }).expect(204);
    w = await t.api.get('/v1/me/wellness?period=all').set(u.auth);
    expect(w.body.moodTrend[0].avgDelta).toBe(2);
  });

  it('revoking a device kills its refresh token', async () => {
    const u = await t.user();
    expect((await t.api.delete(`/v1/me/devices/${u.deviceId}`).set(u.auth)).status).toBe(204);
    expect((await t.api.post('/v1/auth/refresh').send({ refreshToken: u.refreshToken, deviceId: u.deviceId })).status).toBe(401);
    expect((await t.api.delete(`/v1/me/devices/${uuidv7()}`).set(u.auth)).status).toBe(404);
  });

  it('account deletion needs the password, then login fails and a purge job is scheduled', async () => {
    const u = await t.user('leaver');
    expect((await t.api.delete('/v1/me').set(u.auth).send({ password: 'wrong' })).status).toBe(401);
    expect((await t.api.delete('/v1/me').set(u.auth).send({ password: 'correct horse battery' })).status).toBe(202);
    const login = await t.api.post('/v1/auth/login').send({ email: u.user.email, password: 'correct horse battery', device: { id: u.deviceId, platform: 'test', appVersion: '1' } });
    expect(login.status).toBe(401);
    const job = await t.ctx.db.one(`SELECT 1 FROM jobs WHERE type = 'purge-user' AND singleton_key = $1`, [`purge-user:${u.user.id}`]);
    expect(job).toBeTruthy();
  });
});

describe('challenges: discovery, membership, lifecycle', () => {
  it('filters by module/duration, lists mine (created/joined) and paginates', async () => {
    const c = await t.user('creator');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await t.publishedChallenge(c));
    const created = await t.api.get('/v1/challenges?mine=created&limit=2').set(c.auth);
    expect(created.body.items).toHaveLength(2);
    expect(created.body.nextCursor).toBeTruthy();
    const page2 = await t.api.get(`/v1/challenges?mine=created&limit=2&cursor=${created.body.nextCursor}`).set(c.auth);
    expect(page2.body.items).toHaveLength(1);
    expect((await t.api.get('/v1/challenges?module=cycling').set(c.auth)).body.items.find((x: any) => ids.includes(x.id))).toBeFalsy();
    expect((await t.api.get('/v1/challenges?maxDuration=30').set(c.auth)).body.items.find((x: any) => ids.includes(x.id))).toBeFalsy();
    await t.api.post(`/v1/challenges/${ids[0]}/join`).set(owner.auth).send({});
    expect((await t.api.get('/v1/challenges?mine=joined').set(owner.auth)).body.items.map((x: any) => x.id)).toContain(ids[0]);
    expect((await t.api.get('/v1/challenges?near=999,0').set(c.auth)).status).toBe(400);
  });

  it('leave + rejoin; bundle requires membership', async () => {
    const u = await joined();
    expect((await t.api.post(`/v1/challenges/${challengeId}/leave`).set(u.auth)).status).toBe(204);
    expect((await t.api.get(`/v1/challenges/${challengeId}/versions/1/bundle`).set(u.auth)).status).toBe(403);
    expect((await t.api.post(`/v1/challenges/${challengeId}/join`).set(u.auth).send({})).status).toBe(201);
  });

  it('pins participants to their version; a newer published version can be downloaded explicitly', async () => {
    const c = await t.user();
    const id = await t.publishedChallenge(c);
    const p = await t.user();
    await t.api.post(`/v1/challenges/${id}/join`).set(p.auth).send({});
    const def: any = greenSprintDefinition();
    def.meta.title = 'Green Sprint v2';
    await t.api.patch(`/v1/challenges/${id}`).set(c.auth).send({ definition: def, baseVersion: 1 }).expect(200);
    expect((await t.api.get(`/v1/challenges/${id}/versions/1/bundle`).set(p.auth)).body.definition.meta.title).toBe('Green Sprint 60');
    const v2 = await t.api.get(`/v1/challenges/${id}/versions/2/bundle`).set(p.auth);
    expect(v2.body.definition.meta.title).toBe('Green Sprint v2');
    expect((await t.api.get(`/v1/challenges/${id}`).set(p.auth)).body.myParticipation.joinedVersion).toBe(2);
    expect((await t.api.get(`/v1/challenges/${id}/versions/3/bundle`).set(p.auth)).status).toBe(404);
    // Participants were notified of the new version through the pull feed.
    const pull = await t.api.get('/v1/sync/pull').set(p.auth);
    expect(pull.body.changes.some((x: any) => x.kind === 'challenge_version' && x.data.version === 2)).toBe(true);
  });

  it('only the creator can cancel; cancelled challenges leave the leaderboard and reject joins', async () => {
    const c = await t.user();
    const id = await t.publishedChallenge(c);
    const other = await t.user();
    expect((await t.api.post(`/v1/challenges/${id}/cancel`).set(other.auth).send({})).status).toBe(403);
    expect((await t.api.post(`/v1/challenges/${id}/cancel`).set(c.auth).send({ reason: 'rain' })).status).toBe(200);
    expect((await t.api.post(`/v1/challenges/${id}/join`).set(other.auth).send({})).status).toBe(409);
    expect((await t.api.get(`/v1/challenges/${id}/leaderboard`).set(c.auth)).body.entries).toEqual([]);
  });

  it('private challenges are invisible to non-members', async () => {
    const c = await t.user();
    const def: any = greenSprintDefinition();
    def.meta.visibility = 'private';
    const id = await t.publishedChallenge(c, def);
    const stranger = await t.user();
    expect((await t.api.get(`/v1/challenges/${id}`).set(stranger.auth)).status).toBe(404);
    expect((await t.api.get('/v1/challenges').set(stranger.auth)).body.items.find((x: any) => x.id === id)).toBeFalsy();
  });
});

describe('team leaderboard', () => {
  it('aggregates member scores per team', async () => {
    const c = await t.user();
    const def: any = greenSprintDefinition();
    def.mode = 'team';
    def.participants = { min: 1, max: 10, teams: { count: 2, sizeMax: 5 } };
    const id = await t.publishedChallenge(c, def);
    const a = await t.user('teamA1');
    const b = await t.user('teamA2');
    const ja = await t.api.post(`/v1/challenges/${id}/join`).set(a.auth).send({ newTeamName: 'Neem Squad' });
    await t.api.post(`/v1/challenges/${id}/join`).set(b.auth).send({ teamId: ja.body.participation.teamId });
    await playCleanRun(t, a, id, 300);
    await playCleanRun(t, b, id, 310);
    const lb = await t.api.get(`/v1/challenges/${id}/leaderboard?scope=team`).set(a.auth);
    expect(lb.body.entries).toHaveLength(1);
    expect(lb.body.entries[0]).toMatchObject({ name: 'Neem Squad', points: 562 });
  });
});

describe('privacy controls on sessions', () => {
  it('mood is dropped unless opted in; track deletion redacts raw GPS', async () => {
    const u = await joined('private');
    const run = await playCleanRun(t, u, challengeId, 400);
    await t.api.put(`/v1/sessions/${run.sessionId}/mood`).set(u.auth).send({ moodAfter: 5 }).expect(204);
    const s = await t.api.get(`/v1/sessions/${run.sessionId}`).set(u.auth);
    expect(s.body.wellness.moodAfter ?? null).toBeNull();
    const other = await t.user();
    expect((await t.api.put(`/v1/sessions/${run.sessionId}/mood`).set(other.auth).send({ moodAfter: 1 })).status).toBe(403);
    expect((await t.api.put(`/v1/sessions/${run.sessionId}/mood`).set(u.auth).send({ moodAfter: 9 })).status).toBe(400);

    expect((await t.api.delete(`/v1/sessions/${run.sessionId}/track`).set(other.auth)).status).toBe(403);
    expect((await t.api.delete(`/v1/sessions/${run.sessionId}/track`).set(u.auth)).status).toBe(204);
    const batches = await t.ctx.db.query<{ payload: any; redacted: boolean }>(`SELECT payload, redacted FROM activity_events WHERE session_id = $1 AND type = 'LocationBatch'`, [run.sessionId]);
    expect(batches.every((b) => b.redacted && b.payload.samples.length === 0)).toBe(true);
    expect(await t.ctx.db.one('SELECT 1 FROM session_tracks WHERE session_id = $1', [run.sessionId])).toBeNull();
  });

  it('the challenge creator sees results but never mood', async () => {
    const u = await joined('moody');
    await t.api.patch('/v1/me').set(u.auth).send({ shareWellbeing: true });
    const run = await playCleanRun(t, u, challengeId, 500);
    const asOwner = await t.api.get(`/v1/sessions/${run.sessionId}`).set(owner.auth);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.wellness).not.toHaveProperty('moodBefore');
    expect((await t.api.get(`/v1/sessions/${run.sessionId}`).set(u.auth)).body.wellness.moodBefore).toBe(3);
  });
});

describe('evidence uploads', () => {
  it('accepts WebP, rejects other users, caps size', async () => {
    const u = await joined();
    const run = await playCleanRun(t, u, challengeId, 600, { upload: false });
    const webp = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#0a0' } }).webp().toBuffer();
    // WebP bytes don't match the recorded JPEG hash → honest conflict.
    expect((await t.api.put(`/v1/evidence/${run.evidence.litter}/content`).set(u.auth).set('Content-Type', 'image/webp').send(webp)).status).toBe(409);
    const stranger = await t.user();
    expect((await t.api.put(`/v1/evidence/${run.evidence.tree1}/content`).set(stranger.auth).set('Content-Type', 'image/jpeg').send(run.photos.tree1)).status).toBe(403);
    expect((await t.api.put(`/v1/evidence/${uuidv7()}/content`).set(u.auth).set('Content-Type', 'image/jpeg').send(await jpeg(1))).status).toBe(404);
    const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(6 * 1024 * 1024)]);
    expect((await t.api.put(`/v1/evidence/${run.evidence.tree2}/content`).set(u.auth).set('Content-Type', 'image/jpeg').send(huge)).status).toBe(413);
    const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('not really a jpeg')]);
    expect((await t.api.put(`/v1/evidence/${run.evidence.tree2}/content`).set(u.auth).set('Content-Type', 'image/jpeg').send(corrupt)).status).toBe(409);
  });

  it('re-encoded photos have no EXIF/GPS metadata', async () => {
    const u = await joined();
    const run = await playCleanRun(t, u, challengeId, 700);
    const stored = await t.ctx.storage.get(`evidence/web/${run.evidence.litter}.jpg`);
    const meta = await sharp(stored!).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.format).toBe('jpeg');
  });
});

describe('admin', () => {
  it('reject hides a session; takedown archives a challenge; all audited', async () => {
    const admin = await t.user('admin2', 'admin');
    const c = await t.user();
    const id = await t.publishedChallenge(c);
    const u = await t.user();
    await t.api.post(`/v1/challenges/${id}/join`).set(u.auth).send({});
    const run = await playCleanRun(t, u, id, 800);
    expect((await t.api.get(`/v1/challenges/${id}/leaderboard`).set(u.auth)).body.entries).toHaveLength(1);
    await t.api.post(`/v1/admin/sessions/${run.sessionId}/review`).set(admin.auth).send({ decision: 'reject', note: 'test' }).expect(200);
    expect((await t.api.get(`/v1/challenges/${id}/leaderboard`).set(u.auth)).body.entries).toHaveLength(0);
    expect((await t.api.get(`/v1/admin/sessions/${run.sessionId}`).set(admin.auth)).body.timeline.length).toBeGreaterThan(5);
    expect((await t.api.post(`/v1/admin/challenges/${id}/takedown`).set(u.auth).send({ reason: 'spam spam' })).status).toBe(403);
    expect((await t.api.post(`/v1/admin/challenges/${id}/takedown`).set(admin.auth).send({ reason: 'unsafe route' })).status).toBe(200);
    const audit = await t.ctx.db.query<{ action: string }>(`SELECT action FROM audit_log WHERE actor_id = $1`, [admin.user.id]);
    expect(audit.map((a) => a.action).sort()).toEqual(['review', 'takedown', 'view_session']);
  });
});

describe('retention + maintenance job', () => {
  it('redacts raw GPS after 30 days, deletes photos after 90, validates stale sessions, nulls old prompts', async () => {
    const u = await joined('retention');
    const run = await playCleanRun(t, u, challengeId, 900);
    // A completed session missing its photos, last seen 3 days ago.
    const v = await joined('stale');
    const stale = await playCleanRun(t, v, challengeId, 950, { upload: false });
    await t.ctx.db.query(`UPDATE activity_sessions SET last_received_at = now() - interval '3 days' WHERE id = $1`, [stale.sessionId]);
    await t.ctx.db.query(`UPDATE activity_events SET received_at = now() - interval '31 days' WHERE session_id = $1`, [run.sessionId]);
    await t.ctx.db.query(`UPDATE evidence SET created_at = now() - interval '91 days' WHERE session_id = $1`, [run.sessionId]);
    await t.ctx.db.query(`INSERT INTO ai_generations (id, user_id, locality, provider, model_id, prompt_version, input_text, valid, latency_ms, created_at) VALUES ($1, $2, 'server', 'x', 'x', 'v1', 'secret prompt', true, 1, now() - interval '31 days')`, [uuidv7(), u.user.id]);

    await runMaintenance(t.ctx);
    await t.ctx.jobs.drain();

    const batches = await t.ctx.db.query<{ redacted: boolean }>(`SELECT redacted FROM activity_events WHERE session_id = $1 AND type = 'LocationBatch'`, [run.sessionId]);
    expect(batches.every((b) => b.redacted)).toBe(true);
    expect(await t.ctx.db.one('SELECT 1 FROM session_tracks WHERE session_id = $1', [run.sessionId])).toBeTruthy(); // simplified track kept
    expect(await t.ctx.storage.exists(`evidence/web/${run.evidence.litter}.jpg`)).toBe(false);
    expect(Number((await t.ctx.db.one<{ n: string }>(`SELECT count(*) AS n FROM ai_generations WHERE input_text IS NOT NULL AND created_at < now() - interval '30 days'`))!.n)).toBe(0);
    const s = await t.api.get(`/v1/sessions/${stale.sessionId}`).set(v.auth);
    expect(s.body.verdict).toBe('verified_with_notes');
    expect(s.body.flags.map((f: any) => f.code)).toContain('EVIDENCE_MISSING');
    expect(s.body.score.completed).toBe(false);
  });
});

describe('rate limiting (enabled)', () => {
  it('limits login attempts with a 429 problem', async () => {
    const t2 = await setup();
    t2.ctx.config.RATE_LIMITS = true;
    const { createApp } = await import('../src/app');
    const request = (await import('supertest')).default;
    const api = request(createApp(t2.ctx));
    const device = { id: uuidv7(), platform: 'test', appVersion: '1' };
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await api.post('/v1/auth/login').send({ email: 'x@y.dev', password: 'nope', device })).status);
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    await t2.cleanup();
  });
});

describe('token expiry', () => {
  it('expired access tokens get TOKEN_EXPIRED', async () => {
    let now = Date.now();
    const t3 = await setup({ now: () => new Date(now) });
    const u = await t3.user();
    now += 16 * 60_000;
    const r = await t3.api.get('/v1/me').set(u.auth);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('TOKEN_EXPIRED');
    const fresh = await t3.api.post('/v1/auth/refresh').send({ refreshToken: u.refreshToken, deviceId: u.deviceId });
    expect(fresh.status).toBe(200);
    now += 31 * 86_400_000;
    const late = await t3.api.post('/v1/auth/refresh').send({ refreshToken: fresh.body.refreshToken, deviceId: u.deviceId });
    expect(late.body.code).toBe('TOKEN_EXPIRED');
    await t3.cleanup();
  });
});
