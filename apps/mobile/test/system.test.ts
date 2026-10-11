/**
 * SYSTEM TESTS: the whole application (phone core × N + real server + AI routes + validation + admin).
 */
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import { TemplateProvider } from '@trina/ai';
import { uuidv7, type ChallengeDefinitionInput } from '@trina/contracts';
import { compileOrThrow } from '@trina/engine';
import { greenSprintDefinition, greenSprintPoints } from '@trina/engine/fixtures';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createContext } from '../../server/src/app';
import { testConfig } from '../../server/src/config';
import type { AppContext } from '../../server/src/platform/context';
import { ApiClient } from '../src/core/api-client';
import { migrateLocal } from '../src/core/migrations';
import { OfflineStore } from '../src/core/offline-store';
import { SessionManager } from '../src/core/session-manager';
import { SyncWorker } from '../src/core/sync-worker';
import { autoPlay } from './autoplay';
import { FakeClock, fsUploader, memoryTokens } from './helpers';
import { nodeSqlite } from './node-sqlite';

let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let ctx: AppContext;
let baseUrl = '';
let storageDir = '';

beforeAll(async () => {
  const config = testConfig();
  storageDir = config.STORAGE_DIR;
  ctx = await createContext(config, { llm: new TemplateProvider() });
  server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await ctx.db.close();
  await rm(storageDir, { recursive: true, force: true });
});

/** A phone: its own SQLite, token store, device id, clock and sync worker. */
async function newPhone(name: string, fetchImpl: typeof fetch = fetch) {
  const db = nodeSqlite();
  await migrateLocal(db);
  const device = { id: uuidv7(), platform: 'test' as const, appVersion: '0.1.0' };
  const api = new ApiClient({ baseUrl, tokens: memoryTokens(), device, fetchImpl, uploader: fsUploader(fetchImpl) });
  const auth = await api.register({ email: `${name}-${uuidv7()}@t.dev`, password: 'correct horse battery', displayName: name });
  const store = new OfflineStore(db);
  const clock = new FakeClock(Date.now() - 3 * 3_600_000);
  const sm = new SessionManager(db, store, clock, { userId: auth.user.id, deviceId: device.id });
  const sync = new SyncWorker({ db, api, store, deviceId: device.id, random: () => 0 });
  return { name, db, api, auth, store, clock, sm, sync };
}

async function syncUntilIdle(p: Awaited<ReturnType<typeof newPhone>>, max = 20) {
  for (let i = 0; i < max; i++) {
    await p.sync.runOnce();
    const c = await p.sync.counts();
    if (c.pendingEvents + c.pendingPhotos + c.pendingOutbox === 0) return;
    await p.db.run('UPDATE evidence SET next_attempt_at = 0');
    await p.db.run('UPDATE outbox SET next_attempt_at = 0');
  }
  throw new Error(`${p.name} did not reach idle`);
}

describe('whole application: the Hacktoberfest demo, three friends, one cheater', () => {
  it('AI-create → join team → download → play offline → sync → validate → review → leaderboards → impact', async () => {
    // 1. Organizer creates the challenge with the AI route (model offline → rule-based builder) and publishes it.
    const org = await newPhone('Priya');
    const start = greenSprintPoints().start;
    const draft = await org.api.aiDraft({ prompt: 'A 90-minute challenge for 3 friends: walk, collect 10 pieces of garbage and water two trees', context: { startPoint: start } });
    expect(draft.intents[0]!.participants.count).toBe(3);
    const def = draft.definitions[0] as ChallengeDefinitionInput;
    expect(def.modules!.map((m) => m.id)).toEqual(expect.arrayContaining(['walking', 'cleanup', 'tree_care']));
    const created = await org.api.createChallenge(def, uuidv7(), draft.generationId);
    await org.api.publish(created.id, 1);

    // 2. Three friends join the same team and download the bundle.
    const [a, b, c] = [await newPhone('Arjun'), await newPhone('Meera'), await newPhone('Cheater')];
    const ja = await a.api.join(created.id, { newTeamName: 'Grass Squad' });
    for (const p of [b, c]) await p.api.join(created.id, { teamId: ja.participation.teamId! });
    for (const p of [a, b, c]) await p.store.saveBundle(await p.api.bundle(created.id, 1), Date.now());
    await a.api.patchMe({ shareWellbeing: true });
    const compiled = compileOrThrow((await a.store.getChallenge(created.id))!.bundle.definition);

    // 3. Everyone plays OFFLINE (no network calls happen here).
    const sa = await autoPlay(a.sm, a.clock, compiled, created.id, 1, { moodBefore: 2 });
    await a.sm.setMood(sa, 'after', 5);
    const sb = await autoPlay(b.sm, b.clock, compiled, created.id, 1, { stopAfterCheckpoints: 2, abandon: true });
    const sc = await autoPlay(c.sm, c.clock, compiled, created.id, 1, { mocked: true });
    const provisionalA = (await a.sm.snapshot(sa)).score;
    expect(provisionalA.completed).toBe(true);

    // 4. Back online: sync everything; server validates.
    for (const p of [a, b, c]) await syncUntilIdle(p);
    await ctx.jobs.drain();
    for (const p of [a, b, c]) await p.sync.runOnce();

    const ra = await a.api.session(sa);
    const rb = await b.api.session(sb);
    const rc = await c.api.session(sc);
    expect(ra.verdict).toBe('verified');
    expect(ra.score!.totalPoints).toBe(provisionalA.total); // device == server
    expect(ra.wellness).toMatchObject({ moodBefore: 2, moodAfter: null }); // after-mood sent late is not in the sealed event
    expect(rb.score!.completed).toBe(false);
    expect(rb.score!.totalPoints).toBeLessThan(ra.score!.totalPoints);
    expect(rc.verdict).toBe('needs_review');
    expect(rc.flags.map((f) => f.code)).toContain('MOCK_LOCATION');
    expect(rc.score!.breakdown.filter((x: any) => x.ruleId.startsWith('cp:') && x.status === 'awarded')).toHaveLength(0);

    // Phones received their verdicts through pull.
    expect((await a.db.get<{ verdict: string }>('SELECT verdict FROM sessions WHERE id = ?', [sa]))!.verdict).toBe('verified');
    expect((await c.db.get<{ verdict: string }>('SELECT verdict FROM sessions WHERE id = ?', [sc]))!.verdict).toBe('needs_review');

    // 5. Leaderboards: the cheater is pending, not ranked.
    let lb = await a.api.leaderboard(created.id);
    expect(lb.entries.map((e) => e.name)).toEqual(['Arjun', 'Meera']);
    expect(lb.pending).toBe(1);
    const team = await a.api.leaderboard(created.id, 'team');
    expect(team.entries[0]).toMatchObject({ name: 'Grass Squad', points: ra.score!.totalPoints + rb.score!.totalPoints });

    // 6. Admin reviews and rejects the cheater; organizer sees the impact report.
    await ctx.db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [org.auth.user.id]);
    await org.api.logout();
    const adminLogin = await org.api.login({ email: org.auth.user.email, password: 'correct horse battery' });
    expect(adminLogin.user.role).toBe('admin');
    const flags = await org.api.request<{ items: { session_id: string }[] }>('GET', '/v1/admin/flags');
    expect(flags.items.map((i) => i.session_id)).toContain(sc);
    await org.api.request('POST', `/v1/admin/sessions/${sc}/review`, { decision: 'reject', note: 'mock GPS app' });
    lb = await a.api.leaderboard(created.id);
    expect(lb.pending).toBe(0);
    expect(lb.entries).toHaveLength(2);

    const impact = await org.api.request<{ participants: number; verifiedSessions: number; tasks: Record<string, number> }>('GET', `/v1/challenges/${created.id}/impact`);
    expect(impact.participants).toBe(3);
    expect(impact.verifiedSessions).toBe(2);

    // 7. AI recap is generated from server numbers only.
    const recap = await a.api.aiRecap(sa);
    expect(recap.text).toContain(String(ra.score!.totalPoints));
  });
});

describe('chaos: random network failures never lose or duplicate data (property-based)', () => {
  it('eventually syncs exactly once and the verdict matches the on-device score', async () => {
    const org = await newPhone('ChaosOrg');
    const c = await org.api.createChallenge(greenSprintDefinition(), uuidv7());
    await org.api.publish(c.id, 1);
    const compiled = compileOrThrow(greenSprintDefinition());

    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom('ok', 'ok', 'fail_before', 'fail_after'), { minLength: 5, maxLength: 40 }), async (schedule) => {
        let i = 0;
        // Each request: succeed, fail before reaching the server, or reach the server and lose the response.
        const chaotic = (async (url: string | URL | Request, init?: RequestInit) => {
          const mode = schedule[i++ % schedule.length];
          if (mode === 'fail_before') throw new TypeError('network down');
          const res = await fetch(url, init);
          if (mode === 'fail_after') {
            await res.arrayBuffer();
            throw new TypeError('response lost');
          }
          return res;
        }) as typeof fetch;
        const p = await newPhone(`chaos${uuidv7().slice(-6)}`);
        await p.api.join(c.id);
        await p.store.saveBundle(await p.api.bundle(c.id, 1), Date.now());
        // Swap in the chaotic network AFTER setup.
        const api = new ApiClient({ ...p.api.opts, fetchImpl: chaotic, uploader: fsUploader(chaotic) });
        const sync = new SyncWorker({ db: p.db, api, store: p.store, deviceId: p.api.opts.device.id, random: () => 0 });
        const sid = await autoPlay(p.sm, p.clock, compiled, c.id, 1);
        const local = (await p.sm.snapshot(sid)).score.total;

        for (let k = 0; k < 60; k++) {
          await sync.runOnce();
          await p.db.run('UPDATE evidence SET next_attempt_at = 0');
          const n = await sync.counts();
          if (n.pendingEvents + n.pendingPhotos === 0) break;
        }
        if (!schedule.includes('ok')) {
          // The network never works: nothing may be lost or rejected; everything waits on the phone.
          expect(await sync.counts()).toMatchObject({ pendingEvents: (await p.sm.events(sid)).length, failed: 0 });
          return;
        }
        expect(await sync.counts()).toMatchObject({ pendingEvents: 0, pendingPhotos: 0, failed: 0 });
        const serverCount = await ctx.db.one<{ n: string }>('SELECT count(*) AS n FROM activity_events WHERE session_id = $1', [sid]);
        expect(Number(serverCount!.n)).toBe((await p.sm.events(sid)).length);
        await ctx.jobs.drain();
        const runs = await ctx.db.one<{ n: string }>('SELECT count(*) AS n FROM validation_runs WHERE session_id = $1', [sid]);
        expect(Number(runs!.n)).toBe(1);
        const s = await p.api.session(sid);
        expect(s.verdict).toBe('verified');
        expect(s.score!.totalPoints).toBe(local);
      }),
      { numRuns: 12 },
    );
  });
});
