import { rm } from 'node:fs/promises';
import { TemplateProvider } from '@trina/ai';
import { uuidv7 } from '@trina/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError, z } from 'zod';
import { createContext } from '../src/app';
import { loadConfig, testConfig } from '../src/config';
import { createLlmProvider } from '../src/modules/ai/provider';
import { sniffImage } from '../src/modules/evidence/routes';
import { scheduleMaintenance } from '../src/modules/validation/jobs';
import type { AppContext } from '../src/platform/context';
import { errorHandler, HttpError, problem } from '../src/platform/errors';
import { createLogger } from '../src/platform/logger';
import { localStorage } from '../src/platform/storage';
import { DEMO_USERS, seedIfEmpty } from '../src/seed';
import { jpeg } from './helpers';

let ctx: AppContext;
let storageDir: string;
beforeAll(async () => {
  const config = testConfig();
  storageDir = config.STORAGE_DIR;
  ctx = await createContext(config, { llm: new TemplateProvider() });
});
afterAll(async () => {
  await ctx.db.close();
  await rm(storageDir, { recursive: true, force: true });
});

describe('job queue', () => {
  it('runs handlers, de-duplicates by singleton key, retries with backoff and gives up after 5 attempts', async () => {
    let ok = 0;
    let fails = 0;
    ctx.jobs.register('t-ok', async () => void ok++);
    ctx.jobs.register('t-fail', async () => {
      fails++;
      throw new Error('nope');
    });
    await ctx.jobs.enqueue('t-ok', {}, { singletonKey: 'only-once' });
    await ctx.jobs.enqueue('t-ok', {}, { singletonKey: 'only-once' });
    expect(await ctx.jobs.drain()).toBe(1);
    expect(ok).toBe(1);

    await ctx.jobs.enqueue('t-fail', {}, { singletonKey: 'retry-me' });
    for (let i = 0; i < 6; i++) {
      await ctx.db.query(`UPDATE jobs SET run_after = now() WHERE type = 't-fail' AND status = 'queued'`);
      await ctx.jobs.drain();
    }
    const job = await ctx.db.one<{ status: string; attempts: number; last_error: string }>(`SELECT status, attempts, last_error FROM jobs WHERE type = 't-fail'`);
    expect(job).toMatchObject({ status: 'failed', attempts: 5, last_error: 'nope' });
    expect(fails).toBe(5);
  });

  it('fails jobs without a handler and respects delays', async () => {
    await ctx.jobs.enqueue('no-handler', {});
    await ctx.jobs.enqueue('t-ok', {}, { delayMs: 60_000 });
    await ctx.jobs.drain();
    const later = await ctx.db.one<{ status: string }>(`SELECT status FROM jobs WHERE type = 't-ok' AND run_after > now()`);
    expect(later?.status).toBe('queued');
    expect((await ctx.db.one<{ last_error: string }>(`SELECT last_error FROM jobs WHERE type = 'no-handler'`))!.last_error).toMatch(/No handler/);
  });

  it('start/stop polls in-process and schedules maintenance', async () => {
    let ran = 0;
    ctx.jobs.register('tick', async () => void ran++);
    ctx.jobs.start(20);
    await ctx.jobs.enqueue('tick', {});
    await new Promise((r) => setTimeout(r, 150));
    ctx.jobs.stop();
    expect(ran).toBe(1);
    const timer = scheduleMaintenance(ctx, 10_000);
    clearInterval(timer);
    await new Promise((r) => setTimeout(r, 50));
    expect(await ctx.db.one(`SELECT 1 FROM jobs WHERE type = 'maintenance'`)).toBeTruthy();
  });

  it('purge-user hard-deletes only soft-deleted accounts', async () => {
    const id = uuidv7();
    await ctx.db.query(`INSERT INTO users (id, email, password_hash, display_name, deleted_at) VALUES ($1, $2, 'x', 'Gone', now())`, [id, `${id}@x.dev`]);
    const keep = uuidv7();
    await ctx.db.query(`INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'x', 'Stay')`, [keep, `${keep}@x.dev`]);
    await ctx.jobs.enqueue('purge-user', { userId: id });
    await ctx.jobs.enqueue('purge-user', { userId: keep });
    await ctx.jobs.drain();
    expect(await ctx.db.one('SELECT 1 FROM users WHERE id = $1', [id])).toBeNull();
    expect(await ctx.db.one('SELECT 1 FROM users WHERE id = $1', [keep])).toBeTruthy();
  });
});

describe('storage', () => {
  it('stores, reads, checks and deletes; rejects path traversal', async () => {
    const s = localStorage(storageDir);
    await s.put('evidence/web/a.jpg', Buffer.from('x'), 'image/jpeg');
    expect(await s.exists('evidence/web/a.jpg')).toBe(true);
    expect((await s.get('evidence/web/a.jpg'))!.toString()).toBe('x');
    await s.delete('evidence/web/a.jpg');
    expect(await s.get('evidence/web/a.jpg')).toBeNull();
    expect(await s.exists('evidence/web/a.jpg')).toBe(false);
    await expect(s.put('../../etc/passwd', Buffer.from('x'), 'x')).rejects.toThrow(/Unsafe/);
    await expect(s.put('a b;rm', Buffer.from('x'), 'x')).rejects.toThrow(/Unsafe/);
  });
});

describe('config', () => {
  it('requires JWT_SECRET in production and parses booleans', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: undefined as never })).toThrow(/JWT_SECRET/);
    const c = loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), RATE_LIMITS: 'off', RUN_WORKER_IN_PROCESS: 'false' });
    expect(c.RATE_LIMITS).toBe(false);
    expect(c.RUN_WORKER_IN_PROCESS).toBe(false);
    expect(() => loadConfig({ JWT_SECRET: 'short' })).toThrow();
  });
  it('builds a self-hosted provider with the model profile', () => {
    const p = createLlmProvider(loadConfig({ LLM_BASE_URL: 'http://ollama:11434/v1', LLM_MODEL: 'qwen3:8b' }));
    expect(p.id).toBe('http:ollama:11434:qwen3:8b');
    expect(p.capabilities.locality).toBe('self_hosted');
  });
});

describe('seeding', () => {
  it('development seeds demo users + a published Green Sprint, idempotently', async () => {
    const config = testConfig({ NODE_ENV: 'development' });
    const dev = await createContext(config, { llm: new TemplateProvider() });
    await seedIfEmpty(dev);
    await seedIfEmpty(dev);
    const users = await dev.db.query<{ email: string; role: string }>(`SELECT email, role FROM users WHERE email NOT LIKE '%@trina.invalid' ORDER BY email` /* excludes the Daily Quest system anchor (migration 3) */);
    expect(users.map((u) => u.email).sort()).toEqual(DEMO_USERS.map((u) => u.email).sort());
    expect(users.find((u) => u.email === 'organizer@trina.dev')!.role).toBe('admin');
    expect(Number((await dev.db.one<{ n: string }>(`SELECT count(*) AS n FROM challenges WHERE status = 'published'`))!.n)).toBe(1);
    expect(Number((await dev.db.one<{ n: string }>('SELECT count(*) AS n FROM challenge_templates'))!.n)).toBe(2);
    expect(Number((await dev.db.one<{ n: string }>('SELECT count(*) AS n FROM challenge_modules'))!.n)).toBe(10); // 8 built-in + official cricket and football (ADR-023)
    await dev.db.close();
    await rm(config.STORAGE_DIR, { recursive: true, force: true });
  });
  it('test/production never seed demo users', async () => {
    expect(await ctx.db.one(`SELECT 1 FROM users WHERE email = 'arjun@trina.dev'`)).toBeNull();
  });
});

describe('errors and image sniffing', () => {
  it('maps errors to RFC 9457 problem details', () => {
    const run = (err: unknown) => {
      let status = 0;
      let body: any;
      const res = { status: (s: number) => ((status = s), res), type: () => res, json: (b: unknown) => ((body = b), res) } as any;
      errorHandler(createLogger('silent'))(err, { headers: {} } as any, res, () => undefined);
      return { status, body };
    };
    expect(run(new HttpError(409, 'CHALLENGE_FULL', 'full')).body).toMatchObject({ status: 409, code: 'CHALLENGE_FULL', detail: 'full', type: 'https://trina.app/problems/challenge-full' });
    const zerr = (() => { try { z.object({ a: z.string() }).parse({}); } catch (e) { return e as ZodError; } })();
    expect(run(zerr).body.errors[0].path).toBe('a');
    expect(run({ type: 'entity.too.large' }).status).toBe(413);
    expect(run({ type: 'entity.parse.failed' }).status).toBe(400);
    expect(run(new Error('secret internals'))).toMatchObject({ status: 500, body: { code: 'INTERNAL', detail: 'Something went wrong' } });
    expect(problem(418 as never, 'INTERNAL').title).toBe('Error');
  });
  it('sniffs JPEG and WebP magic bytes only', async () => {
    expect(sniffImage(await jpeg(1))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffImage(Buffer.from('<svg/>'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});
