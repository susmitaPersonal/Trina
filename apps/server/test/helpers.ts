import { rm } from 'node:fs/promises';
import { TemplateProvider } from '@trina/ai';
import { uuidv7, type AuthResponse } from '@trina/contracts';
import { greenSprintDefinition } from '@trina/engine/fixtures';
import sharp from 'sharp';
import request from 'supertest';
import { createApp, createContext } from '../src/app';
import { testConfig } from '../src/config';
import type { AppContext } from '../src/platform/context';
import { seedIfEmpty } from '../src/seed';

export type TestUser = AuthResponse & { deviceId: string; auth: { Authorization: string } };

export async function setup(overrides: Partial<AppContext> = {}) {
  const config = testConfig();
  const ctx = await createContext(config, { llm: new TemplateProvider(), ...overrides });
  await seedIfEmpty(ctx);
  const app = createApp(ctx);
  const api = request(app);
  let n = 0;

  async function user(name = `user${++n}`, role: 'user' | 'admin' = 'user'): Promise<TestUser> {
    const deviceId = uuidv7();
    const res = await api
      .post('/v1/auth/register')
      .send({ email: `${name}-${uuidv7()}@test.dev`, password: 'correct horse battery', displayName: name, ageConfirmed: true, device: { id: deviceId, platform: 'test', appVersion: '0.1.0' } });
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
    if (role === 'admin') {
      await ctx.db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [res.body.user.id]);
      const login = await api.post('/v1/auth/login').send({ email: res.body.user.email, password: 'correct horse battery', device: { id: deviceId, platform: 'test', appVersion: '0.1.0' } });
      return { ...login.body, deviceId, auth: { Authorization: `Bearer ${login.body.accessToken}` } };
    }
    return { ...res.body, deviceId, auth: { Authorization: `Bearer ${res.body.accessToken}` } };
  }

  async function publishedChallenge(owner: TestUser, def: unknown = greenSprintDefinition()) {
    const c = await api.post('/v1/challenges').set(owner.auth).set('Idempotency-Key', uuidv7()).send({ definition: def });
    if (c.status !== 201) throw new Error(`create failed ${c.status} ${JSON.stringify(c.body)}`);
    const p = await api.post(`/v1/challenges/${c.body.id}/publish`).set(owner.auth).send({ version: 1 });
    if (p.status !== 200) throw new Error(`publish failed ${p.status} ${JSON.stringify(p.body)}`);
    return c.body.id as string;
  }

  async function cleanup() {
    await ctx.db.close();
    await rm(config.STORAGE_DIR, { recursive: true, force: true });
  }

  return { ctx, app, api, user, publishedChallenge, cleanup };
}

/** A small, real JPEG (unique per seed so hashes differ). */
export async function jpeg(seed = 1): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 24, channels: 3, background: { r: seed % 255, g: (seed * 7) % 255, b: (seed * 13) % 255 } } })
    .jpeg()
    .toBuffer();
}

/* ------------------------------ session helpers ------------------------------ */
import { createHash } from 'node:crypto';
import { computeEventHash, definitionHash, type ActivityEvent } from '@trina/contracts';
import { compileOrThrow } from '@trina/engine';
import { greenSprintCleanRun } from '@trina/engine/fixtures';

export const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
export const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
export const GS_HASH = definitionHash(compileOrThrow(greenSprintDefinition()).definition);

export function pushEvents(api: request.Agent | ReturnType<typeof request>, u: TestUser, sessionId: string, events: ActivityEvent[]) {
  return (api as ReturnType<typeof request>)
    .post('/v1/sync/push')
    .set(u.auth)
    .send({ protocolVersion: 1, deviceId: u.deviceId, batchId: uuidv7(), sessions: [{ sessionId, events }] });
}

/** Clean Green Sprint run re-sealed with REAL photo hashes; optionally uploads photos and validates. */
export async function playCleanRun(t: Awaited<ReturnType<typeof setup>>, u: TestUser, challengeId: string, seed: number, opts: { upload?: boolean } = { upload: true }) {
  const photos = { litter: await jpeg(seed), tree1: await jpeg(seed + 1), tree2: await jpeg(seed + 2) };
  const v = await t.ctx.db.one<{ definition_hash: string; version: number }>(
    'SELECT v.definition_hash, v.version FROM challenge_versions v JOIN challenge_participants p ON p.challenge_id = v.challenge_id AND p.joined_version = v.version WHERE v.challenge_id = $1 AND p.user_id = $2',
    [challengeId, u.user.id],
  );
  const run = greenSprintCleanRun({ challengeId, definitionHash: v?.definition_hash ?? GS_HASH, userId: u.user.id, deviceId: u.deviceId, startTs: hoursAgo(2) });
  const map: Record<string, string> = { [run.shas.litter]: sha(photos.litter), [run.shas.tree1]: sha(photos.tree1), [run.shas.tree2]: sha(photos.tree2) };
  let prev = run.events[0]!.prevHash;
  const events = run.events.map((e) => {
    const payload = e.type === 'EvidenceCaptured' ? { ...e.payload, sha256: map[e.payload.sha256] ?? e.payload.sha256 } : e.payload;
    const base = { ...e, payload, prevHash: prev } as ActivityEvent;
    const hash = computeEventHash(base);
    prev = hash;
    return { ...base, hash } as ActivityEvent;
  });
  const res = await pushEvents(t.api, u, run.sessionId, events);
  if (res.status !== 200) throw new Error(`push failed ${res.status}`);
  if (opts.upload !== false) {
    for (const k of ['litter', 'tree1', 'tree2'] as const) {
      await t.api.put(`/v1/evidence/${run.evidence[k]}/content`).set(u.auth).set('Content-Type', 'image/jpeg').send(photos[k]);
    }
    await t.ctx.jobs.drain();
  }
  return { ...run, events, photos };
}
