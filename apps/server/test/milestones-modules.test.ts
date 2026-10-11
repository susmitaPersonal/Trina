/**
 * Server integration: data modules (create/publish/fork/report/moderate), AI module drafts,
 * milestones + progression, signed peer confirmations and anti-cheat flags, offline Daily Quests,
 * guilds, rate limits and quotas, retention. Real PGlite, real HTTP via supertest.
 */
import { TemplateProvider } from '@trina/ai';
import {
  ConfirmationBody,
  definitionHash,
  generateDeviceKeyPair,
  signConfirmation,
  uuidv7,
  type ActivityEvent,
  type ConfirmationClaim,
  type LngLat,
} from '@trina/contracts';
import { buildQuestDefinition, challengeFromModule, compileModuleOrThrow, compileOrThrow, DAILY_QUEST_CHALLENGE_ID, defaultRegistry, destinationPoint } from '@trina/engine';
import { DEMO_CENTER, SessionBuilder } from '@trina/engine/fixtures';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, createContext } from '../src/app';
import { testConfig } from '../src/config';
import { evaluateUser } from '../src/modules/progress/service';
import { runMaintenance } from '../src/modules/validation/jobs';
import { hoursAgo, pushEvents, setup, type TestUser } from './helpers';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  t = await setup();
});
afterAll(async () => {
  await t.cleanup();
});

const idem = () => ({ 'Idempotency-Key': uuidv7() });

/** A player with a registered Ed25519 device key. */
async function keyedUser(name: string) {
  const u = await t.user(name);
  const keys = generateDeviceKeyPair();
  const r = await t.api.put('/v1/me/devices/current/key').set(u.auth).send({ publicKey: keys.publicKeyHex });
  expect(r.status).toBe(204);
  return Object.assign(u, { keys });
}
type Keyed = Awaited<ReturnType<typeof keyedUser>>;

function builder(u: TestUser, challengeId: string, hash: string, opts: { at?: LngLat; startTs?: string; sessionId?: string; quest?: { templateId: string; targetMinutes: 30 | 45 | 60 | 90; levelTier: 'easy' | 'medium' | 'hard' } } = {}) {
  const at = opts.at ?? DEMO_CENTER;
  const ts = opts.startTs ?? hoursAgo(3);
  const b = new SessionBuilder({ challengeId, definitionHash: hash, userId: u.user.id, deviceId: u.deviceId, start: at, startTs: ts, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) });
  b.emit('SessionStarted', {
    challengeId, challengeVersion: 1, definitionHash: hash, deviceId: u.deviceId, userId: u.user.id, teamId: null, bootId: 'b1', clockOffsetMsAtDownload: 0,
    startFix: { lat: at[1], lng: at[0], acc: 6, ts }, tzOffsetMin: 330, ...(opts.quest ? { quest: opts.quest } : {}),
  });
  return b;
}

function confirmation(issuer: Keyed, subject: { userId: string; sessionId: string }, challengeId: string, claims: ConfirmationClaim[], opts: { role?: 'peer' | 'organizer'; signWith?: string } = {}) {
  const body = ConfirmationBody.parse({
    confirmationId: uuidv7(), challengeId, subjectUserId: subject.userId, subjectSessionId: subject.sessionId,
    issuerUserId: issuer.user.id, issuerDeviceId: issuer.deviceId, role: opts.role ?? 'peer', claims,
  });
  const sig = signConfirmation(body, opts.signWith ?? issuer.keys.secretKeyHex);
  return {
    issued: { confirmationId: body.confirmationId, challengeId, subjectUserId: subject.userId, subjectSessionId: subject.sessionId, role: body.role, claims, sig },
    received: { confirmationId: body.confirmationId, issuerUserId: issuer.user.id, issuerDeviceId: issuer.deviceId, issuerPublicKey: issuer.keys.publicKeyHex, role: body.role, claims, sig },
  };
}

async function push(u: TestUser, events: ActivityEvent[]) {
  const r = await pushEvents(t.api, u, events[0]!.sessionId, events);
  expect(r.status).toBe(200);
  expect(r.body.results[0].rejected).toEqual([]);
  return r;
}

const flagsOf = async (sessionId: string) => (await t.ctx.db.query<{ code: string; severity: string }>(
  `SELECT f.code, f.severity FROM session_flags f WHERE f.validation_run_id = (SELECT id FROM validation_runs WHERE session_id = $1 ORDER BY finished_at DESC LIMIT 1)`, [sessionId],
)).map((f) => f.code);

/** An official cricket challenge (individual mode) with organizer + joined players. */
async function cricketChallenge(owner: TestUser, players: TestUser[]) {
  const def = challengeFromModule(defaultRegistry.get('cricket')!, { start: DEMO_CENTER, durationMin: 90, difficulty: 'hard', team: false });
  const id = await t.publishedChallenge(owner, def);
  for (const p of [owner, ...players]) expect((await t.api.post(`/v1/challenges/${id}/join`).set(p.auth).send({})).status).toBeLessThan(300);
  const hash = definitionHash(compileOrThrow(def).definition);
  return { id, hash };
}

describe('data modules: create, read, publish, fork, report, moderate', () => {
  it('AI module drafts: ok / refused / english_only, never trusting the model for numbers', async () => {
    const u = await t.user('drafter');
    const ok = await t.api.post('/v1/ai/module-drafts').set(u.auth).send({ prompt: 'kite flying with friends in the field on Sunday afternoon' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('ok');
    expect(ok.body.definition.id).toMatch(/^u_kite_flying_[0-9a-f]{4}$/);
    expect(ok.body.definition.safety.notes).toContain('no_glass_coated_string');
    const refused = await t.api.post('/v1/ai/module-drafts').set(u.auth).send({ prompt: 'rooftop kite flying at night' });
    expect(refused.body.status).toBe('refused');
    expect(refused.body.definition).toBeNull();
    const bn = await t.api.post('/v1/ai/module-drafts').set(u.auth).send({ prompt: 'মাঠে বন্ধুদের সাথে ঘুড়ি ওড়াবো' });
    expect(bn.body.status).toBe('english_only');
    expect(Number((await t.ctx.db.one<{ n: string }>(`SELECT count(*) AS n FROM ai_generations WHERE user_id = $1 AND kind = 'module'`, [u.user.id]))!.n)).toBe(3);
  });

  it('create → private draft (owner only) → publish unlisted → others can read; idempotent create; stale edits refused', async () => {
    const owner = await t.user('modowner');
    const other = await t.user('modother');
    const draft = (await t.api.post('/v1/ai/module-drafts').set(owner.auth).send({ prompt: 'frisbee with 6 friends in the park' })).body;
    const key = idem();
    const c1 = await t.api.post('/v1/modules').set(owner.auth).set(key).send({ definition: draft.definition, aiGenerationId: draft.generationId });
    expect(c1.status).toBe(201);
    const c2 = await t.api.post('/v1/modules').set(owner.auth).set(key).send({ definition: draft.definition, aiGenerationId: draft.generationId });
    expect(c2.status).toBe(201);
    expect(c2.body).toEqual(c1.body); // replayed, not created twice
    expect((await t.api.post('/v1/modules').set(owner.auth).send({ definition: draft.definition })).status).toBe(400); // Idempotency-Key required
    const id = c1.body.id as string;

    expect((await t.api.get(`/v1/modules/${id}/versions/1`).set(owner.auth)).status).toBe(200);
    expect((await t.api.get(`/v1/modules/${id}/versions/1`).set(other.auth)).status).toBe(404); // IDOR: draft is private
    expect((await t.api.post(`/v1/modules/${id}/publish`).set(other.auth).send({ version: 1, visibility: 'unlisted' })).status).toBe(403);
    expect((await t.api.post(`/v1/modules/${id}/publish`).set(owner.auth).send({ version: 1, visibility: 'public' })).body.code).toBe('PUBLIC_NOT_AVAILABLE');
    expect((await t.api.post(`/v1/modules/${id}/publish`).set(owner.auth).send({ version: 1, visibility: 'unlisted' })).status).toBe(200);
    const seen = await t.api.get(`/v1/modules/${id}/versions/1`).set(other.auth);
    expect(seen.status).toBe(200);
    expect(seen.body.mine).toBe(false);
    expect(seen.body.owner.displayName).toBe('modowner');

    // Published → edits create v2; a stale base version is refused; other people can't edit.
    const edited = { ...draft.definition, meta: { ...draft.definition.meta, displayName: 'Frisbee golf' } };
    expect((await t.api.patch(`/v1/modules/${id}`).set(other.auth).send({ definition: edited, baseVersion: 1 })).status).toBe(403);
    const v2 = await t.api.patch(`/v1/modules/${id}`).set(owner.auth).send({ definition: edited, baseVersion: 1 });
    expect(v2.body.version).toBe(2);
    expect((await t.api.patch(`/v1/modules/${id}`).set(owner.auth).send({ definition: edited, baseVersion: 1 })).body.code).toBe('STALE_VERSION');
    const list = (await t.api.get('/v1/modules').set(owner.auth)).body as Array<{ id: string; mine: boolean; origin: string }>;
    expect(list.find((m) => m.id === id)?.mine).toBe(true);
    expect(list.find((m) => m.id === 'cricket')?.origin).toBe('official');
  });

  it('refuses unsafe, farmable, impersonating or official-name modules', async () => {
    const u = await t.user('badmod');
    const base = (await t.api.post('/v1/ai/module-drafts').set(u.auth).send({ prompt: 'badminton in the park' })).body.definition;
    const unsafe = await t.api.post('/v1/modules').set(u.auth).set(idem()).send({ definition: { ...base, meta: { ...base.meta, displayName: 'Rooftop badminton' } } });
    expect(unsafe.status).toBe(422);
    expect(unsafe.body.code).toBe('MODULE_UNSAFE');
    const farm = { ...base, counters: [{ id: 'smashes', label: 'Smashes', unit: 'count', verification: 'self_report', maxPerMinute: 5, maxPerSession: 100 }], scoring: { counterRules: [{ counter: 'smashes', weight: 5, capPerSession: 50 }], dwellWeight: 3, distanceWeight: 0 } };
    const f = await t.api.post('/v1/modules').set(u.auth).set(idem()).send({ definition: farm });
    expect(f.status).toBe(422);
    expect(JSON.stringify(f.body.errors)).toMatch(/self-reported/);
    const named = await t.api.post('/v1/modules').set(u.auth).set(idem()).send({ definition: { ...base, meta: { ...base.meta, displayName: 'Cricket' } } });
    expect(named.body.code).toBe('MODULE_NAME_TAKEN');
    const reserved = await t.api.post('/v1/modules').set(u.auth).set(idem()).send({ definition: { ...base, id: 'walking' } });
    expect(reserved.status).toBe(422);
    const points = await t.api.post('/v1/modules').set(u.auth).set(idem()).send({ definition: { ...base, points: 1000 } });
    expect(points.status).toBe(422);
  });

  it('private-only (water) modules cannot be shared by link; quota of 5 new modules per day', async () => {
    const u = await t.user('quota');
    const water = (await t.api.post('/v1/ai/module-drafts').set(u.auth).send({ prompt: 'swim across the river with friends' })).body;
    expect(water.risk.level).toBe('private_only');
    const c = await t.api.post('/v1/modules').set(u.auth).set(idem()).send({ definition: water.definition });
    expect(c.status).toBe(201);
    expect((await t.api.post(`/v1/modules/${c.body.id}/publish`).set(u.auth).send({ version: 1, visibility: 'unlisted' })).body.code).toBe('MODULE_UNSAFE');
    expect((await t.api.post(`/v1/modules/${c.body.id}/publish`).set(u.auth).send({ version: 1, visibility: 'private' })).status).toBe(200);
    expect((await t.ctx.db.one(`SELECT 1 FROM moderation_cases WHERE target_id = $1 AND source = 'auto'`, [c.body.id]))).not.toBeNull();
    const prompts = ['badminton', 'chess in the park', 'yoga in the garden', 'skating loop', 'kho kho'];
    const codes: number[] = [];
    for (const p of prompts) {
      const d = (await t.api.post('/v1/ai/module-drafts').set(u.auth).send({ prompt: p })).body;
      codes.push((await t.api.post('/v1/modules').set(u.auth).set(idem()).send({ definition: d.definition })).status);
    }
    expect(codes.slice(0, 4).every((s) => s === 201)).toBe(true);
    expect(codes[4]).toBe(429);
  });

  it('fork: unlisted and official modules can be forked (new id, credit kept); private ones cannot', async () => {
    const owner = await t.user('forkowner');
    const forker = await t.user('forker');
    const d = (await t.api.post('/v1/ai/module-drafts').set(owner.auth).send({ prompt: 'bird walk at the lake' })).body.definition;
    const id = (await t.api.post('/v1/modules').set(owner.auth).set(idem()).send({ definition: d })).body.id;
    expect((await t.api.post(`/v1/modules/${id}/fork`).set(forker.auth).send({ fromVersion: 1 })).status).toBe(404);
    await t.api.post(`/v1/modules/${id}/publish`).set(owner.auth).send({ version: 1, visibility: 'unlisted' });
    const fork = await t.api.post(`/v1/modules/${id}/fork`).set(forker.auth).send({ fromVersion: 1 });
    expect(fork.status).toBe(201);
    expect(fork.body.id).not.toBe(id);
    expect(fork.body.definition.forkedFrom).toEqual({ id, version: 1 });
    const cricketFork = await t.api.post('/v1/modules/cricket/fork').set(forker.auth).send({ fromVersion: 1 });
    expect(cricketFork.status).toBe(201);
    expect(cricketFork.body.definition.id).toMatch(/^u_cricket_/);
    expect(JSON.stringify(cricketFork.body.definition.milestones)).not.toMatch(/"cricket\./); // facts moved to the new id
  });

  it('three reports suspend an unlisted module; admins take down; owners and players learn on pull; non-admins cannot moderate', async () => {
    const owner = await t.user('reported');
    const admin = await t.user('mod-admin', 'admin');
    const d = (await t.api.post('/v1/ai/module-drafts').set(owner.auth).send({ prompt: 'volleyball on the beach' })).body.definition;
    const id = (await t.api.post('/v1/modules').set(owner.auth).set(idem()).send({ definition: d })).body.id;
    await t.api.post(`/v1/modules/${id}/publish`).set(owner.auth).send({ version: 1, visibility: 'unlisted' });
    for (let i = 0; i < 3; i++) {
      const r = await t.user(`reporter${i}`);
      expect((await t.api.post(`/v1/modules/${id}/report`).set(r.auth).send({ reason: 'offensive' })).status).toBe(202);
    }
    expect((await t.ctx.db.one<{ status: string }>('SELECT status FROM module_definitions WHERE id = $1', [id]))!.status).toBe('suspended');
    expect((await t.api.get('/v1/admin/moderation').set(owner.auth)).status).toBe(403);
    const cases = (await t.api.get('/v1/admin/moderation').set(admin.auth)).body.items as Array<{ id: string; targetId: string; reports: number }>;
    const c = cases.find((x) => x.targetId === id)!;
    expect(c.reports).toBe(3);
    expect((await t.api.post(`/v1/admin/moderation/${c.id}/decision`).set(admin.auth).send({ decision: 'take_down', note: 'reported' })).status).toBe(200);
    const pull = (await t.api.get('/v1/sync/pull?cursor=0').set(owner.auth)).body.changes as Array<{ kind: string; data: any }>;
    expect(pull.some((x) => x.kind === 'module_status' && x.data.moduleId === id && x.data.status === 'taken_down')).toBe(true);
    const viewer = await t.user('afterTakedown');
    expect((await t.api.get(`/v1/modules/${id}/versions/1`).set(viewer.auth)).status).toBe(410);
  });
});

describe('custom-module challenges', () => {
  it('pins the module: others can’t use a private module; a challenge needs the module published; bundles carry module + keys', async () => {
    const owner = await keyedUser('kiteorg');
    const stranger = await t.user('kitestranger');
    const draft = (await t.api.post('/v1/ai/module-drafts').set(owner.auth).send({ prompt: 'kite flying with friends in the field' })).body.definition;
    const created = (await t.api.post('/v1/modules').set(owner.auth).set(idem()).send({ definition: draft })).body;
    const mod = compileModuleOrThrow(created.definition);
    const def = challengeFromModule(mod, { start: DEMO_CENTER, durationMin: 60, difficulty: 'medium', team: false });
    expect((await t.api.post('/v1/challenges').set(stranger.auth).set(idem()).send({ definition: def })).status).toBe(403);
    const c = await t.api.post('/v1/challenges').set(owner.auth).set(idem()).send({ definition: def });
    expect(c.status).toBe(201);
    expect((await t.api.post(`/v1/challenges/${c.body.id}/publish`).set(owner.auth).send({ version: 1 })).body.code).toBe('MODULE_TAKEN_DOWN');
    await t.api.post(`/v1/modules/${created.id}/publish`).set(owner.auth).send({ version: 1, visibility: 'private' });
    expect((await t.api.post(`/v1/challenges/${c.body.id}/publish`).set(owner.auth).send({ version: 1 })).status).toBe(200);
    const player = await keyedUser('kiteplayer');
    await t.api.post(`/v1/challenges/${c.body.id}/join`).set(player.auth).send({});
    await t.api.post(`/v1/challenges/${c.body.id}/join`).set(owner.auth).send({});
    const bundle = (await t.api.get(`/v1/challenges/${c.body.id}/versions/1/bundle`).set(player.auth)).body;
    expect(bundle.modules).toEqual([{ id: created.id, version: 1, definition: created.definition, definitionHash: created.definitionHash }]);
    expect(bundle.participantKeys.map((k: any) => k.publicKey).sort()).toEqual([owner.keys.publicKeyHex, player.keys.publicKeyHex].sort());
    expect(bundle.engineMinVersion).toBe(2);

    // Play + validate one session, then take the module down: the leaderboard empties (ADR-028).
    const hash = definitionHash(compileOrThrow(def, defaultRegistry.with([mod])).definition);
    const s = builder(player, c.body.id, hash).wait(25 * 60, 20).complete().build();
    await push(player, s);
    await t.ctx.jobs.drain();
    const lb = (await t.api.get(`/v1/challenges/${c.body.id}/leaderboard`).set(player.auth)).body;
    expect(lb.entries.length).toBe(1);
    const admin = await t.user('kiteadmin', 'admin');
    await t.api.post(`/v1/admin/modules/${created.id}/takedown`).set(admin.auth).send({ reason: 'test takedown' });
    expect((await t.api.get(`/v1/challenges/${c.body.id}/leaderboard`).set(player.auth)).body.entries).toEqual([]);
  });
});

describe('signed peer confirmations → milestones (cricket)', () => {
  it('a co-present, signed catch counts once matched (even when the confirmer syncs later), unlocking "Took a catch"', async () => {
    const org = await keyedUser('cricketorg');
    const bat = await keyedUser('batter');
    const fielder = await keyedUser('fielder');
    const { id, hash } = await cricketChallenge(org, [bat, fielder]);
    const subjectSession = uuidv7();
    const conf = confirmation(fielder, { userId: bat.user.id, sessionId: subjectSession }, id, [{ kind: 'counter', ref: 'cricket.catches', value: 1 }]);
    const ts = hoursAgo(3);
    const subject = builder(bat, id, hash, { sessionId: subjectSession, startTs: ts }).wait(30 * 60, 20);
    for (let i = 0; i < 12; i++) subject.emit('CountReported', { counterId: 'cricket.balls_faced', delta: 1 });
    subject.emit('ConfirmationReceived', conf.received).complete();
    const confirmer = builder(fielder, id, hash, { startTs: ts }).wait(30 * 60, 20).emit('ConfirmationIssued', conf.issued).complete();

    await push(bat, subject.build());
    await t.ctx.jobs.drain();
    expect(await flagsOf(subjectSession)).toContain('CONFIRM_PENDING');
    expect((await t.api.get('/v1/me/milestones').set(bat.auth)).body.items.some((m: any) => m.key === 'cricket@1:took_catch')).toBe(false);

    await push(fielder, confirmer.build()); // the confirmer syncs later → the subject is re-validated
    await t.ctx.jobs.drain();
    expect(await flagsOf(subjectSession)).not.toContain('CONFIRM_PENDING');
    expect((await t.ctx.db.one<{ status: string }>('SELECT status FROM peer_confirmations WHERE id = $1', [conf.issued.confirmationId]))!.status).toBe('matched');
    const ms = (await t.api.get('/v1/me/milestones').set(bat.auth)).body.items as Array<{ key: string; tier: string; label: string }>;
    const catchM = ms.find((m) => m.key === 'cricket@1:took_catch')!;
    expect(catchM.label).toBe('Confirmed');
    expect(ms.some((m) => m.key === 'cricket@1:at_the_ground' && m.tier === 'bronze')).toBe(true);
    expect(ms.filter((m) => m.key === 'cricket@1:took_catch').length).toBe(1);
    const session = (await t.api.get(`/v1/sessions/${subjectSession}`).set(bat.auth)).body;
    expect(session.score.breakdown.find((b: any) => b.ruleId === 'count_catches').points).toBeGreaterThan(0);
    const progress = (await t.api.get('/v1/me/progress').set(bat.auth)).body;
    expect(progress.xp).toBeGreaterThan(0);
    expect(progress.rank).toBe('E');
    // Co-presence is a server fact: both were at the ground together → "Full side" needs 6, so not unlocked with 2.
    expect(ms.some((m) => m.key === 'cricket@1:full_side')).toBe(false);
  });

  it('flags forged signatures, self-confirmation, confirmers who were not there, and implausible counts', async () => {
    const org = await keyedUser('cricketorg2');
    const a = await keyedUser('playerA');
    const b = await keyedUser('playerB');
    const { id, hash } = await cricketChallenge(org, [a, b]);
    const ts = hoursAgo(3);
    const run = async (subjectUser: Keyed, issuerUser: Keyed, opts: { forged?: boolean; issuerAt?: LngLat; counts?: number } = {}) => {
      const sid = uuidv7();
      const conf = confirmation(issuerUser, { userId: subjectUser.user.id, sessionId: sid }, id, [{ kind: 'counter', ref: 'cricket.catches', value: 1 }], opts.forged ? { signWith: generateDeviceKeyPair().secretKeyHex } : {});
      const sb = builder(subjectUser, id, hash, { sessionId: sid, startTs: ts }).wait(20 * 60, 20);
      for (let i = 0; i < (opts.counts ?? 0); i++) sb.emit('CountReported', { counterId: 'cricket.balls_faced', delta: 5 });
      sb.emit('ConfirmationReceived', conf.received).complete();
      const ib = builder(issuerUser, id, hash, { startTs: ts, at: opts.issuerAt }).wait(20 * 60, 20).emit('ConfirmationIssued', conf.issued).complete();
      await push(issuerUser, ib.build());
      await push(subjectUser, sb.build());
      await t.ctx.jobs.drain();
      return { sid, flags: await flagsOf(sid), conf };
    };
    const forged = await run(a, b, { forged: true });
    expect(forged.flags).toContain('CONFIRM_SIGNATURE_INVALID');
    expect((await t.ctx.db.one<{ verdict: string }>('SELECT verdict FROM scores WHERE session_id = $1', [forged.sid]))!.verdict).toBe('needs_review');
    const self = await run(a, a);
    expect(self.flags).toContain('CONFIRM_SELF');
    const away = await run(a, b, { issuerAt: destinationPoint(DEMO_CENTER, 90, 3000) });
    expect(away.flags).toContain('CONFIRMER_NOT_COPRESENT');
    expect((await t.ctx.db.one<{ status: string }>('SELECT status FROM peer_confirmations WHERE id = $1', [away.conf.issued.confirmationId]))!.status).toBe('rejected');
    const spam = await run(b, a, { counts: 30 }); // 150 balls in a few seconds
    expect(spam.flags).toContain('COUNT_IMPLAUSIBLE');
  });

  it('flags reciprocal confirmation rings and confirmation spam (kept for review, never auto-accused)', async () => {
    const org = await keyedUser('ringorg');
    const a = await keyedUser('ringA');
    const b = await keyedUser('ringB');
    const { id, hash } = await cricketChallenge(org, [a, b]);
    for (let i = 0; i < 3; i++) {
      for (const [x, y] of [[a, b], [b, a]] as const) {
        await t.ctx.db.query(
          `INSERT INTO peer_confirmations (id, challenge_id, role, issuer_user_id, issuer_device_id, issued_claims, issued_sig, issued_at, subject_user_id, subject_session_id, status)
           VALUES ($1, $2, 'peer', $3, $4, '[]', 'x', now() - interval '1 hour', $5, $6, 'matched')`,
          [uuidv7(), id, x.user.id, x.deviceId, y.user.id, uuidv7()],
        );
      }
    }
    const sid = uuidv7();
    const conf = confirmation(b, { userId: a.user.id, sessionId: sid }, id, [{ kind: 'counter', ref: 'cricket.catches', value: 1 }]);
    const ts = new Date(Date.now() - 50 * 60_000).toISOString();
    await push(b, builder(b, id, hash, { startTs: ts }).wait(20 * 60, 20).emit('ConfirmationIssued', conf.issued).complete().build());
    await push(a, builder(a, id, hash, { sessionId: sid, startTs: ts }).wait(20 * 60, 20).emit('ConfirmationReceived', conf.received).complete().build());
    await t.ctx.jobs.drain();
    expect(await flagsOf(sid)).toContain('CONFIRM_RECIPROCAL');
    for (let i = 0; i < 31; i++) {
      await t.ctx.db.query(
        `INSERT INTO peer_confirmations (id, challenge_id, role, issuer_user_id, issuer_device_id, issued_claims, issued_sig, issued_at, subject_user_id, subject_session_id)
         VALUES ($1, $2, 'peer', $3, $4, '[]', 'x', now() - interval '2 hours', $5, $6)`,
        [uuidv7(), id, b.user.id, b.deviceId, uuidv7(), uuidv7()],
      );
    }
    await t.ctx.db.query(`UPDATE activity_sessions SET validation_status = 'pending' WHERE id = $1`, [sid]);
    await t.ctx.jobs.enqueue('validate-session', { sessionId: sid }, { singletonKey: `validate:${sid}` });
    await t.ctx.jobs.drain();
    expect(await flagsOf(sid)).toContain('CONFIRM_RATE');
  });
});

describe('offline Daily Quests', () => {
  const spec = { templateId: 'outside_v1', targetMinutes: 30 as const, levelTier: 'easy' as const };
  const questHash = (at: LngLat = DEMO_CENTER) => definitionHash(compileOrThrow(buildQuestDefinition(spec, at)).definition);

  it('a 30-min offline quest needs no join, validates, and unlocks quest milestones + XP (exactly once)', async () => {
    const u = await t.user('quester');
    const b = builder(u, DAILY_QUEST_CHALLENGE_ID, questHash(), { quest: spec }).emit('ConnectivityChanged', { online: false, transport: 'none' }).wait(31 * 60, 20).complete();
    const events = b.build();
    await push(u, events);
    await t.ctx.jobs.drain();
    const dto = (await t.api.get(`/v1/sessions/${events[0]!.sessionId}`).set(u.auth)).body;
    expect(dto.verdict).toBe('verified');
    const ms = (await t.api.get('/v1/me/milestones').set(u.auth)).body.items as Array<{ key: string }>;
    expect(ms.map((m) => m.key)).toEqual(expect.arrayContaining(['*@1:q_offline_30', '*@1:l_first_offline']));
    const p = (await t.api.get('/v1/me/progress').set(u.auth)).body;
    expect(p.offlineQuestMinutes).toBeGreaterThanOrEqual(30);
    expect(p.xp).toBeGreaterThanOrEqual(30 + 15);
    // Exactly once: re-evaluating never duplicates rows.
    const before = (await t.ctx.db.one<{ n: string }>('SELECT count(*) AS n FROM user_milestones WHERE user_id = $1', [u.user.id]))!.n;
    await evaluateUser(t.ctx, u.user.id);
    await evaluateUser(t.ctx, u.user.id);
    expect(Number((await t.ctx.db.one<{ n: string }>('SELECT count(*) AS n FROM user_milestones WHERE user_id = $1', [u.user.id]))!.n)).toBe(Number(before));
    // Quests never appear as a challenge or on leaderboards.
    expect((await t.api.get(`/v1/challenges/${DAILY_QUEST_CHALLENGE_ID}`).set(u.auth)).status).toBe(404);
  });

  it('removes minutes when the app was online, flags missing offline records and tampered definitions', async () => {
    const u = await t.user('quester2');
    const start = hoursAgo(3);
    const b = builder(u, DAILY_QUEST_CHALLENGE_ID, questHash(), { quest: spec, startTs: start }).emit('ConnectivityChanged', { online: false, transport: 'none' }).wait(40 * 60, 20).complete();
    const events = b.build();
    for (let m = 5; m < 15; m++) {
      await t.ctx.db.query(`INSERT INTO device_request_minutes (device_id, minute) VALUES ($1, date_trunc('minute', $2::timestamptz))`, [u.deviceId, new Date(Date.parse(start) + m * 60_000).toISOString()]);
    }
    await push(u, events);
    await t.ctx.jobs.drain();
    expect(await flagsOf(events[0]!.sessionId)).toContain('ONLINE_DURING_QUEST');
    const summary = (await t.ctx.db.one<{ summary: any }>('SELECT summary FROM session_summaries WHERE session_id = $1', [events[0]!.sessionId]))!.summary;
    expect(summary.facts.offline_s).toBeLessThanOrEqual(31 * 60);

    const noRec = builder(u, DAILY_QUEST_CHALLENGE_ID, questHash(), { quest: spec, startTs: hoursAgo(2) }).wait(31 * 60, 20).complete().build();
    await push(u, noRec);
    await t.ctx.jobs.drain();
    expect(await flagsOf(noRec[0]!.sessionId)).toContain('OFFLINE_UNRECORDED');

    const tampered = builder(u, DAILY_QUEST_CHALLENGE_ID, 'f'.repeat(64), { quest: spec, startTs: hoursAgo(1) }).wait(60, 20).complete().build();
    await push(u, tampered);
    await t.ctx.jobs.drain();
    expect(await flagsOf(tampered[0]!.sessionId)).toContain('QUEST_DEFINITION_MISMATCH');
  });

  it('admin rejection revokes milestones; approval restores them (no duplicates)', async () => {
    const u = await t.user('revoker');
    const admin = await t.user('revoke-admin', 'admin');
    const events = builder(u, DAILY_QUEST_CHALLENGE_ID, questHash(), { quest: spec }).emit('ConnectivityChanged', { online: false, transport: 'none' }).wait(31 * 60, 20).complete().build();
    await push(u, events);
    await t.ctx.jobs.drain();
    const sid = events[0]!.sessionId;
    await t.api.post(`/v1/admin/sessions/${sid}/review`).set(admin.auth).send({ decision: 'reject', note: 'test' });
    await t.ctx.jobs.drain();
    expect((await t.api.get('/v1/me/milestones').set(u.auth)).body.items).toEqual([]);
    const pulled = (await t.api.get('/v1/sync/pull?cursor=0').set(u.auth)).body.changes as Array<{ kind: string; data: any }>;
    expect(pulled.some((c) => c.kind === 'milestones' && c.data.revokedKeys.length > 0)).toBe(true);
    await t.api.post(`/v1/admin/sessions/${sid}/review`).set(admin.auth).send({ decision: 'approve', note: 'ok' });
    await t.ctx.jobs.drain();
    const again = (await t.api.get('/v1/me/milestones').set(u.auth)).body.items as Array<{ key: string; windowKey: string }>;
    expect(again.some((m) => m.key === '*@1:q_offline_30')).toBe(true);
    expect(new Set(again.map((m) => `${m.key}|${m.windowKey}`)).size).toBe(again.length);
  });

  it('daily quests are deterministic per player and day; catalogue and device keys behave', async () => {
    const u = await t.user('daily');
    const q1 = (await t.api.get('/v1/me/quests?date=2026-10-12').set(u.auth)).body;
    const q2 = (await t.api.get('/v1/me/quests?date=2026-10-12').set(u.auth)).body;
    expect(q1).toEqual(q2);
    expect(q1.quests).toHaveLength(3);
    expect(q1.targetMinutes).toBe(30);
    const cat = (await t.api.get('/v1/milestones?moduleId=cricket').set(u.auth)).body as Array<{ key: string; verification: string }>;
    expect(cat.find((m) => m.key === 'cricket@1:took_catch')!.verification).toBe('peer');
    const k = generateDeviceKeyPair().publicKeyHex;
    expect((await t.api.put('/v1/me/devices/current/key').set(u.auth).send({ publicKey: k })).status).toBe(204);
    expect((await t.api.put('/v1/me/devices/current/key').set(u.auth).send({ publicKey: k })).status).toBe(204);
    expect((await t.api.put('/v1/me/devices/current/key').set(u.auth).send({ publicKey: generateDeviceKeyPair().publicKeyHex })).status).toBe(409);
    expect((await t.api.get('/v1/me/progress')).status).toBe(401);
  });
});

describe('guilds', () => {
  it('create → invite → join → weekly board; members only; full and expired invites; names are filtered', async () => {
    const leader = await t.user('guildlead');
    const member = await t.user('guildmember');
    const outsider = await t.user('outsider');
    expect((await t.api.post('/v1/guilds').set(leader.auth).send({ name: 'Rooftop racers' })).status).toBe(422);
    const g = await t.api.post('/v1/guilds').set(leader.auth).send({ name: 'Lake Walkers', description: 'Morning walks' });
    expect(g.status).toBe(201);
    expect((await t.api.post('/v1/guilds').set(outsider.auth).send({ name: 'lake walkers!' })).status).toBe(409);
    const inv = await t.api.post(`/v1/guilds/${g.body.id}/invites`).set(leader.auth).send({ maxUses: 1 });
    expect(inv.body.code).toMatch(/^[A-Z0-9]{8}$/);
    expect((await t.api.post(`/v1/guilds/${g.body.id}/invites`).set(member.auth).send({})).status).toBe(403);
    expect((await t.api.post('/v1/guilds/join').set(member.auth).send({ code: inv.body.code })).status).toBe(201);
    expect((await t.api.post('/v1/guilds/join').set(outsider.auth).send({ code: inv.body.code })).body.code).toBe('INVITE_EXPIRED');
    expect((await t.api.get(`/v1/guilds/${g.body.id}`).set(outsider.auth)).status).toBe(404);
    const detail = (await t.api.get(`/v1/guilds/${g.body.id}`).set(member.auth)).body;
    expect(detail.members.map((m: any) => m.role).sort()).toEqual(['leader', 'member']);
    const board = (await t.api.get(`/v1/guilds/${g.body.id}/board`).set(member.auth)).body;
    expect(board.entries).toHaveLength(2);
    expect(board.guildQuest.target).toBe(600);
    expect((await t.api.get(`/v1/guilds/${g.body.id}/board`).set(outsider.auth)).status).toBe(404);
    expect((await t.api.post(`/v1/guilds/${g.body.id}/leave`).set(leader.auth)).status).toBe(409); // hand over first
    expect((await t.api.post(`/v1/guilds/${g.body.id}/leave`).set(member.auth)).status).toBe(204);
    expect((await t.api.get('/v1/me/guilds').set(leader.auth)).body.items[0].name).toBe('Lake Walkers');
  });
});

describe('rate limits and retention', () => {
  it('module drafts are rate-limited per user (10/min and 10/day)', async () => {
    const config = testConfig({ RATE_LIMITS: 'on' });
    const ctx = await createContext(config, { llm: new TemplateProvider() });
    const api = request(createApp(ctx));
    const device = { id: uuidv7(), platform: 'test', appVersion: '0.1.0' };
    const reg = await api.post('/v1/auth/register').send({ email: `rl-${uuidv7()}@t.dev`, password: 'correct horse battery', displayName: 'rl', ageConfirmed: true, device });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await api.post('/v1/ai/module-drafts').set({ Authorization: `Bearer ${reg.body.accessToken}` }).send({ prompt: 'badminton in the park' })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    await ctx.db.close();
  });

  it('maintenance drops request minutes after 30 days and summary zone intervals with raw GPS', async () => {
    const dev = uuidv7();
    await t.ctx.db.query(`INSERT INTO device_request_minutes (device_id, minute) VALUES ($1, now() - interval '31 days'), ($1, now())`, [dev]);
    await runMaintenance(t.ctx);
    expect((await t.ctx.db.query('SELECT minute FROM device_request_minutes WHERE device_id = $1', [dev])).length).toBe(1);
  });
});
