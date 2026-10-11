import { uuidv7 } from '@trina/contracts';
import { greenSprintDefinition } from '@trina/engine/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup } from './helpers';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  t = await setup();
});
afterAll(async () => {
  await t.cleanup();
});

describe('health', () => {
  it('reports ok', async () => {
    const r = await t.api.get('/v1/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, db: 'pglite' });
  });
  it('returns problem+json for unknown routes', async () => {
    const r = await t.api.get('/v1/nope');
    expect(r.status).toBe(404);
    expect(r.headers['content-type']).toMatch(/problem\+json/);
    expect(r.body.code).toBe('NOT_FOUND');
  });
});

describe('auth', () => {
  const device = { id: uuidv7(), platform: 'test', appVersion: '0.1.0' };
  const email = `priya-${uuidv7()}@test.dev`;
  let refresh = '';

  it('registers, rejects duplicates and weak input', async () => {
    const ok = await t.api.post('/v1/auth/register').send({ email, password: 'correct horse battery', displayName: 'Priya', ageConfirmed: true, device });
    expect(ok.status).toBe(201);
    expect(ok.body.user.email).toBe(email);
    expect(ok.body.user).not.toHaveProperty('password_hash');
    refresh = ok.body.refreshToken;
    const dup = await t.api.post('/v1/auth/register').send({ email, password: 'correct horse battery', displayName: 'Priya', ageConfirmed: true, device });
    expect(dup.status).toBe(409);
    const weak = await t.api.post('/v1/auth/register').send({ email: 'x@y.dev', password: 'short', displayName: 'P', ageConfirmed: true, device });
    expect(weak.status).toBe(400);
    expect(weak.body.errors.length).toBeGreaterThan(0);
  });

  it('logs in and rejects bad passwords with a generic error', async () => {
    const bad = await t.api.post('/v1/auth/login').send({ email, password: 'wrong password!!', device });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('INVALID_CREDENTIALS');
    const unknown = await t.api.post('/v1/auth/login').send({ email: 'nobody@test.dev', password: 'whatever123', device });
    expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
    const ok = await t.api.post('/v1/auth/login').send({ email, password: 'correct horse battery', device });
    expect(ok.status).toBe(200);
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const r1 = await t.api.post('/v1/auth/refresh').send({ refreshToken: refresh, deviceId: device.id });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(refresh);
    // Reusing the old token revokes the family, including the new token.
    const reuse = await t.api.post('/v1/auth/refresh').send({ refreshToken: refresh, deviceId: device.id });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('TOKEN_REUSED');
    const after = await t.api.post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken, deviceId: device.id });
    expect(after.status).toBe(401);
  });

  it('protects routes and serves /me', async () => {
    expect((await t.api.get('/v1/me')).status).toBe(401);
    expect((await t.api.get('/v1/me').set('Authorization', 'Bearer garbage')).status).toBe(401);
    const u = await t.user('meuser');
    const me = await t.api.get('/v1/me').set(u.auth);
    expect(me.status).toBe(200);
    expect(me.body.user.displayName).toBe('meuser');
    const patched = await t.api.patch('/v1/me').set(u.auth).send({ shareWellbeing: true });
    expect(patched.body.user.shareWellbeing).toBe(true);
    const devices = await t.api.get('/v1/me/devices').set(u.auth);
    expect(devices.body[0].current).toBe(true);
  });

  it('logout revokes the refresh family', async () => {
    const u = await t.user('logout');
    expect((await t.api.post('/v1/auth/logout').set(u.auth).send({ refreshToken: u.refreshToken })).status).toBe(204);
    expect((await t.api.post('/v1/auth/refresh').send({ refreshToken: u.refreshToken, deviceId: u.deviceId })).status).toBe(401);
  });
});

describe('challenges', () => {
  it('lists modules and templates', async () => {
    const u = await t.user();
    const m = await t.api.get('/v1/modules').set(u.auth);
    expect(m.body.map((x: any) => x.id)).toContain('tree_care');
    const tpl = await t.api.get('/v1/templates').set(u.auth);
    expect(tpl.body.items.map((x: any) => x.title)).toContain('Green Sprint 60');
  });

  it('requires an Idempotency-Key and replays the same response', async () => {
    const u = await t.user();
    const no = await t.api.post('/v1/challenges').set(u.auth).send({ definition: greenSprintDefinition() });
    expect(no.status).toBe(400);
    const key = uuidv7();
    const a = await t.api.post('/v1/challenges').set(u.auth).set('Idempotency-Key', key).send({ definition: greenSprintDefinition() });
    const b = await t.api.post('/v1/challenges').set(u.auth).set('Idempotency-Key', key).send({ definition: greenSprintDefinition() });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    const changed = await t.api.post('/v1/challenges').set(u.auth).set('Idempotency-Key', key).send({ definition: { ...greenSprintDefinition(), meta: { title: 'Other' } } });
    expect(changed.status).toBe(409);
  });

  it('rejects definitions that do not compile with 422 and reasons', async () => {
    const u = await t.user();
    const def: any = greenSprintDefinition();
    def.tasks[0].type = 'cleanup.vacuum_ocean';
    const r = await t.api.post('/v1/challenges').set(u.auth).set('Idempotency-Key', uuidv7()).send({ definition: def });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('COMPILE_FAILED');
    expect(r.body.errors[0].message).toMatch(/Unknown task type/);
  });

  it('hides drafts from others, publishes, discovers nearby, joins and serves the offline bundle', async () => {
    const owner = await t.user('owner');
    const other = await t.user('other');
    const c = await t.api.post('/v1/challenges').set(owner.auth).set('Idempotency-Key', uuidv7()).send({ definition: greenSprintDefinition() });
    expect((await t.api.get(`/v1/challenges/${c.body.id}`).set(other.auth)).status).toBe(404);
    expect((await t.api.post(`/v1/challenges/${c.body.id}/join`).set(other.auth).send({})).status).toBe(404);
    expect((await t.api.post(`/v1/challenges/${c.body.id}/publish`).set(other.auth).send({ version: 1 })).status).toBe(403);
    expect((await t.api.post(`/v1/challenges/${c.body.id}/publish`).set(owner.auth).send({ version: 1 })).status).toBe(200);

    const near = await t.api.get('/v1/challenges?near=22.51,88.35&radiusKm=5').set(other.auth);
    const found = near.body.items.find((x: any) => x.id === c.body.id);
    expect(found).toBeTruthy();
    expect(found.distanceKm).toBeLessThan(1);
    const far = await t.api.get('/v1/challenges?near=40.7,-74.0&radiusKm=5').set(other.auth);
    expect(far.body.items.find((x: any) => x.id === c.body.id)).toBeFalsy();

    expect((await t.api.get(`/v1/challenges/${c.body.id}/versions/1/bundle`).set(other.auth)).status).toBe(403);
    const j1 = await t.api.post(`/v1/challenges/${c.body.id}/join`).set(other.auth).send({});
    expect(j1.status).toBe(201);
    const j2 = await t.api.post(`/v1/challenges/${c.body.id}/join`).set(other.auth).send({});
    expect(j2.status).toBe(200); // idempotent re-join

    const b = await t.api.get(`/v1/challenges/${c.body.id}/versions/1/bundle`).set(other.auth);
    expect(b.status).toBe(200);
    expect(b.body.maxScore).toBe(310);
    expect(b.body.ruleText.join(' ')).toMatch(/Lake Gate/);
    expect(b.body.encouragement.length).toBeGreaterThan(3);
    expect(b.body.definitionHash).toMatch(/^[0-9a-f]{64}$/);

    const detail = await t.api.get(`/v1/challenges/${c.body.id}`).set(other.auth);
    expect(detail.body.myParticipation.status).toBe('joined');
    expect(detail.body.challenge.participants).toBe(1);
  });

  it('versions published challenges and rejects stale edits', async () => {
    const owner = await t.user();
    const id = await t.publishedChallenge(owner);
    const def: any = greenSprintDefinition();
    def.meta.title = 'Green Sprint 60 (v2)';
    const v2 = await t.api.patch(`/v1/challenges/${id}`).set(owner.auth).send({ definition: def, baseVersion: 1 });
    expect(v2.body.version).toBe(2);
    const stale = await t.api.patch(`/v1/challenges/${id}`).set(owner.auth).send({ definition: def, baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
  });

  it('enforces capacity and team creation for team challenges', async () => {
    const owner = await t.user();
    const def: any = greenSprintDefinition();
    def.mode = 'team';
    def.participants = { min: 1, max: 2, teams: { count: 1, sizeMax: 2 } };
    const id = await t.publishedChallenge(owner, def);
    const a = await t.user();
    const b = await t.user();
    const c = await t.user();
    const ja = await t.api.post(`/v1/challenges/${id}/join`).set(a.auth).send({ newTeamName: 'Green Team' });
    expect(ja.body.participation.teamId).toBeTruthy();
    const jb = await t.api.post(`/v1/challenges/${id}/join`).set(b.auth).send({ teamId: ja.body.participation.teamId });
    expect(jb.status).toBe(201);
    const jc = await t.api.post(`/v1/challenges/${id}/join`).set(c.auth).send({ newTeamName: 'Late' });
    expect(jc.status).toBe(409);
    expect(jc.body.code).toBe('CHALLENGE_FULL');
  });
});
