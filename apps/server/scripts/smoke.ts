/**
 * LIVE SMOKE TEST: spawns the real server process and exercises the full product over HTTP.
 *   pnpm smoke            (from repo root)
 * Exits non-zero on any failure. Uses a throwaway PGlite dir and evidence dir.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeEventHash, definitionHash, generateDeviceKeyPair, newNonce, signParty, uuidv7, type ActivityEvent, type PartyInvite, type SightingToken } from '@trina/contracts';
import { buildPartyDefinition, buildQuestDefinition, challengeFromModule, compileModuleOrThrow, compileOrThrow, DAILY_QUEST_CHALLENGE_ID, PARTY_CHALLENGE_ID } from '@trina/engine';
import { DEMO_CENTER, SessionBuilder, greenSprintCleanRun } from '@trina/engine/fixtures';
import sharp from 'sharp';

const PORT = 3000 + Math.floor(Math.random() * 1000) + 1000;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'trina-smoke-'));
let step = 0;
const ok = (msg: string) => console.log(`  ✅ ${String(++step).padStart(2)}. ${msg}`);
const fail = (msg: string): never => {
  throw new Error(msg);
};

const proc = spawn('npx', ['tsx', 'src/server.ts'], {
  cwd: join(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', PGLITE_DIR: join(dir, 'db'), STORAGE_DIR: join(dir, 'evidence'), LOG_LEVEL: 'warn', LLM_BASE_URL: 'http://127.0.0.1:9/v1', LLM_TIMEOUT_MS: '500', PUBLIC_BASE_URL: BASE },
  stdio: ['ignore', 'inherit', 'inherit'],
});

async function http<T = any>(method: string, path: string, body?: unknown, token?: string, extra: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

async function main() {
  console.log(`\n🌱 Trina live smoke test → ${BASE}\n`);
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/v1/health`)).ok) break;
    } catch {
      /* booting */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const health = await http('GET', '/v1/health');
  if (health.body?.ok !== true) fail('server did not become healthy');
  ok(`server healthy (db=${health.body.db}, engine v${health.body.engineVersion})`);

  const device = { id: uuidv7(), platform: 'test', appVersion: 'smoke' };
  const login = await http('POST', '/v1/auth/login', { email: 'organizer@trina.dev', password: 'touch-grass-2026', device });
  if (login.status !== 200) fail(`seeded login failed ${login.status}`);
  const orgToken = login.body.accessToken as string;
  ok('seeded organizer can log in');

  const nearby = await http('GET', '/v1/challenges?near=22.51,88.35&radiusKm=5', undefined, orgToken);
  if (!nearby.body.items.some((c: any) => c.title === 'Green Sprint 60')) fail('seeded challenge not discoverable nearby');
  ok(`discover nearby returns ${nearby.body.items.length} challenge(s)`);

  const draft = await http('POST', '/v1/ai/challenge-drafts', { prompt: 'A 60-minute walk for 4 friends, collect litter and water two trees', context: { startPoint: [88.35, 22.5115] } }, orgToken);
  if (draft.status !== 200 || !draft.body.definitions[0]) fail('AI draft failed');
  ok(`AI draft created via ${draft.body.provider.id} (model offline → graceful fallback)`);

  const created = await http('POST', '/v1/challenges', { definition: draft.body.definitions[0], aiGenerationId: draft.body.generationId }, orgToken, { 'Idempotency-Key': uuidv7() });
  if (created.status !== 201) fail(`create failed ${created.status} ${JSON.stringify(created.body)}`);
  await http('POST', `/v1/challenges/${created.body.id}/publish`, { version: 1 }, orgToken);
  ok('AI-drafted challenge created and published');

  const pDevice = { id: uuidv7(), platform: 'test', appVersion: 'smoke' };
  const reg = await http('POST', '/v1/auth/register', { email: `smoke-${uuidv7()}@trina.dev`, password: 'correct horse battery', displayName: 'Smoke Tester', ageConfirmed: true, device: pDevice });
  if (reg.status !== 201) fail('register failed');
  const token = reg.body.accessToken as string;
  const userId = reg.body.user.id as string;
  ok('participant registered');

  const gs = nearby.body.items.find((c: any) => c.title === 'Green Sprint 60');
  if ((await http('POST', `/v1/challenges/${gs.id}/join`, {}, token)).status !== 201) fail('join failed');
  const bundle = await http('GET', `/v1/challenges/${gs.id}/versions/1/bundle`, undefined, token);
  if (!bundle.body.definitionHash) fail('bundle failed');
  ok(`joined + downloaded offline bundle (${bundle.body.ruleText.length} rule lines, max ${bundle.body.maxScore} pts)`);

  // Play offline (simulated) with real photos.
  const photos = await Promise.all([1, 2, 3].map((n) => sharp({ create: { width: 30, height: 30, channels: 3, background: { r: n * 60, g: 120, b: 40 } } }).jpeg().toBuffer()));
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const run = greenSprintCleanRun({ challengeId: gs.id, definitionHash: bundle.body.definitionHash, userId, deviceId: pDevice.id, startTs: new Date(Date.now() - 2 * 3_600_000).toISOString() });
  const shaMap: Record<string, string> = { [run.shas.litter]: sha(photos[0]!), [run.shas.tree1]: sha(photos[1]!), [run.shas.tree2]: sha(photos[2]!) };
  let prev = run.events[0]!.prevHash;
  const events = run.events.map((e) => {
    const payload = e.type === 'EvidenceCaptured' ? { ...e.payload, sha256: shaMap[e.payload.sha256]! } : e.payload;
    const base = { ...e, payload, prevHash: prev } as ActivityEvent;
    prev = computeEventHash(base);
    return { ...base, hash: prev } as ActivityEvent;
  });
  const push = await http('POST', '/v1/sync/push', { protocolVersion: 1, deviceId: pDevice.id, batchId: uuidv7(), sessions: [{ sessionId: run.sessionId, events }] }, token);
  if (push.body.results?.[0]?.ackedThroughSeq !== events.length) fail(`push not fully acked: ${JSON.stringify(push.body)}`);
  const again = await http('POST', '/v1/sync/push', { protocolVersion: 1, deviceId: pDevice.id, batchId: uuidv7(), sessions: [{ sessionId: run.sessionId, events }] }, token);
  if (again.body.results[0].duplicates !== events.length) fail('retry was not idempotent');
  ok(`pushed ${events.length} offline events; retry → ${again.body.results[0].duplicates} duplicates, 0 new`);

  const ids = [run.evidence.litter, run.evidence.tree1, run.evidence.tree2];
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${BASE}/v1/evidence/${ids[i]}/content`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' }, body: photos[i] });
    if (r.status !== 201) fail(`upload ${i} → ${r.status}`);
  }
  ok('uploaded 3 evidence photos (hash-bound, EXIF stripped)');

  let session: any = null;
  for (let i = 0; i < 30; i++) {
    session = (await http('GET', `/v1/sessions/${run.sessionId}`, undefined, token)).body;
    if (session.verdict) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (session?.verdict !== 'verified') fail(`expected verified, got ${session?.verdict} ${JSON.stringify(session?.flags)}`);
  ok(`background worker validated the session: ${session.verdict}, ${session.score.totalPoints} pts, ${session.wellness.steps} steps`);

  const lb = await http('GET', `/v1/challenges/${gs.id}/leaderboard`, undefined, token);
  if (lb.body.entries[0]?.name !== 'Smoke Tester') fail('leaderboard not updated');
  ok(`leaderboard rank #1: ${lb.body.entries[0].name} (${lb.body.entries[0].points} pts)`);

  const pull = await http('GET', '/v1/sync/pull?cursor=0', undefined, token);
  if (!pull.body.changes.some((c: any) => c.kind === 'session_result')) fail('pull did not deliver the result');
  ok('pull feed delivered the verified result to the phone');

  const ev = await http('GET', `/v1/evidence/${run.evidence.litter}`, undefined, token);
  const img = await fetch(ev.body.url);
  if (img.status !== 200 || img.headers.get('content-type') !== 'image/jpeg') fail('signed evidence URL failed');
  ok('signed, short-lived evidence URL serves the photo');

  const recap = await http('POST', '/v1/ai/recaps', { sessionId: run.sessionId }, token);
  if (!String(recap.body.text).includes(String(session.score.totalPoints))) fail('recap mismatch');
  ok(`recap: "${recap.body.text}"`);

  /* ---------------- milestones, data modules, offline Daily Quests (engine v2) ---------------- */
  const waitFor = async <T,>(fn: () => Promise<T | null | undefined | false>, what: string): Promise<T> => {
    for (let i = 0; i < 40; i++) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 500));
    }
    return fail(`timed out waiting for ${what}`);
  };
  const ms = await waitFor(async () => {
    const r = await http('GET', '/v1/me/milestones', undefined, token);
    return r.body.items?.length ? r.body.items : null;
  }, 'milestones');
  const prog = (await http('GET', '/v1/me/progress', undefined, token)).body;
  if (!(prog.xp > 0)) fail('no XP after a verified session');
  ok(`milestones unlocked from the verified session: ${ms.length} (e.g. "${ms[0].title}", ${ms[0].label}); ${prog.xp} XP, rank ${prog.rank}`);

  const quests = (await http('GET', '/v1/me/quests', undefined, token)).body;
  if (quests.quests?.length !== 3) fail('daily quests');
  ok(`today's Daily Quests: ${quests.quests.map((q: any) => q.title).join(' · ')}`);

  const refused = (await http('POST', '/v1/ai/module-drafts', { prompt: 'rooftop kite flying at night' }, orgToken)).body;
  if (refused.status !== 'refused') fail('unsafe module was not refused');
  ok(`AI Module Builder refuses unsafe ideas: "${refused.refusal}"`);

  const draftM = (await http('POST', '/v1/ai/module-drafts', { prompt: 'kite flying with friends in the field on Sunday afternoon' }, orgToken)).body;
  if (draftM.status !== 'ok') fail(`module draft failed ${JSON.stringify(draftM)}`);
  const mod = await http('POST', '/v1/modules', { definition: draftM.definition, aiGenerationId: draftM.generationId }, orgToken, { 'Idempotency-Key': uuidv7() });
  if (mod.status !== 201) fail(`create module ${mod.status} ${JSON.stringify(mod.body)}`);
  if ((await http('POST', `/v1/modules/${mod.body.id}/publish`, { version: 1, visibility: 'unlisted' }, orgToken)).status !== 200) fail('publish module');
  const kiteDef = challengeFromModule(compileModuleOrThrow(mod.body.definition), { start: DEMO_CENTER, durationMin: 60, difficulty: 'medium', team: false });
  const kite = await http('POST', '/v1/challenges', { definition: kiteDef }, orgToken, { 'Idempotency-Key': uuidv7() });
  if (kite.status !== 201) fail(`custom-module challenge ${kite.status} ${JSON.stringify(kite.body)}`);
  await http('POST', `/v1/challenges/${kite.body.id}/publish`, { version: 1 }, orgToken);
  await http('POST', `/v1/challenges/${kite.body.id}/join`, {}, token);
  const kb = (await http('GET', `/v1/challenges/${kite.body.id}/versions/1/bundle`, undefined, token)).body;
  if (kb.modules?.[0]?.id !== mod.body.id) fail('bundle is missing the custom module');
  ok(`custom module "${mod.body.definition.meta.displayName}" (${mod.body.id}) → challenge → bundle ships the module for offline play`);

  const spec = { templateId: 'outside_v1', targetMinutes: 30 as const, levelTier: 'easy' as const };
  const qhash = definitionHash(compileOrThrow(buildQuestDefinition(spec, DEMO_CENTER)).definition);
  const qts = new Date(Date.now() - 90 * 60_000).toISOString();
  const qb = new SessionBuilder({ challengeId: DAILY_QUEST_CHALLENGE_ID, definitionHash: qhash, userId, deviceId: pDevice.id, start: DEMO_CENTER, startTs: qts });
  qb.emit('SessionStarted', {
    challengeId: DAILY_QUEST_CHALLENGE_ID, challengeVersion: 1, definitionHash: qhash, deviceId: pDevice.id, userId, teamId: null, bootId: 'smoke', clockOffsetMsAtDownload: 0,
    startFix: { lat: DEMO_CENTER[1], lng: DEMO_CENTER[0], acc: 6, ts: qts }, tzOffsetMin: 330, quest: spec,
  });
  qb.emit('ConnectivityChanged', { online: false, transport: 'none' }).wait(31 * 60, 20).complete();
  const qevents = qb.build();
  const qpush = await http('POST', '/v1/sync/push', { protocolVersion: 1, deviceId: pDevice.id, batchId: uuidv7(), sessions: [{ sessionId: qb.sessionId, events: qevents }] }, token);
  if (qpush.body.results?.[0]?.ackedThroughSeq !== qevents.length) fail(`quest push ${JSON.stringify(qpush.body)}`);
  await waitFor(async () => (await http('GET', `/v1/sessions/${qb.sessionId}`, undefined, token)).body.verdict === 'verified', 'quest verdict');
  const qms = await waitFor(async () => {
    const r = (await http('GET', '/v1/me/milestones', undefined, token)).body.items as Array<{ key: string }>;
    return r.some((m) => m.key === '*@1:q_offline_30') ? r : null;
  }, 'quest milestone');
  const prog2 = (await http('GET', '/v1/me/progress', undefined, token)).body;
  ok(`offline Daily Quest (no join, rebuilt on the server) verified → "Finish a 30-min offline quest" unlocked; ${prog2.offlineQuestMinutes} offline min, ${prog2.xp} XP (${qms.length} milestones)`);

  // 20. Offline party (ADR-033/034): two new players, signed QR invite + two-sided sightings, synced separately.
  const players = await Promise.all(['Party Host', 'Party Member'].map(async (name) => {
    const device = { id: uuidv7(), platform: 'test', appVersion: 'smoke' };
    const r = await http('POST', '/v1/auth/register', { email: `smoke-party-${uuidv7()}@trina.dev`, password: 'correct horse battery', displayName: name, ageConfirmed: true, device });
    if (r.status !== 201) fail(`party register ${r.status}`);
    const keys = generateDeviceKeyPair();
    if ((await http('PUT', '/v1/me/devices/current/key', { publicKey: keys.publicKeyHex }, r.body.accessToken)).status !== 204) fail('device key');
    return { name, device, keys, token: r.body.accessToken as string, userId: r.body.user.id as string };
  }));
  const [ph, pm] = players as [(typeof players)[number], (typeof players)[number]];
  const pspec = { v: 1 as const, templateId: 'party_outside_v1' as const, targetMinutes: 30 as const, levelTier: 'easy' as const, themeId: 'park_explorers' as const };
  const ibody = { partyId: uuidv7(), spec: pspec, startFix: DEMO_CENTER, hostUserId: ph.userId, hostDeviceId: ph.device.id, hostName: ph.name, hostPublicKey: ph.keys.publicKeyHex, createdAt: new Date().toISOString() };
  const invite: PartyInvite = { t: 'pinv', body: ibody, sig: signParty('invite', ibody, ph.keys.secretKeyHex) };
  const phash = definitionHash(compileOrThrow(buildPartyDefinition(pspec, DEMO_CENTER)).definition);
  const pts = new Date(Date.now() - 60 * 60_000).toISOString();
  const sessions = [ph, pm].map((p, i) => {
    const b = new SessionBuilder({ challengeId: PARTY_CHALLENGE_ID, definitionHash: phash, userId: p.userId, deviceId: p.device.id, start: DEMO_CENTER, startTs: pts });
    b.emit('SessionStarted', {
      challengeId: PARTY_CHALLENGE_ID, challengeVersion: 1, definitionHash: phash, deviceId: p.device.id, userId: p.userId, teamId: null, bootId: 'smoke', clockOffsetMsAtDownload: 0,
      startFix: { lat: DEMO_CENTER[1], lng: DEMO_CENTER[0], acc: 6, ts: pts }, tzOffsetMin: 330, party: { invite, role: i === 0 ? 'host' : 'member' },
    });
    return { p, b };
  });
  const tok = (x: (typeof sessions)[number], replyTo: string | null): SightingToken => {
    const { seq, chainHead } = x.b.head;
    const body = { partyId: ibody.partyId, userId: x.p.userId, deviceId: x.p.device.id, sessionId: x.b.sessionId, name: x.p.name, publicKey: x.p.keys.publicKeyHex, seq, chainHead, nonce: newNonce(), replyTo };
    return { t: 'psig', body, sig: signParty('sighting', body, x.p.keys.secretKeyHex) };
  };
  const [sh, sm2] = sessions as [(typeof sessions)[number], (typeof sessions)[number]];
  for (const kind of ['join', 'wrapup'] as const) {
    if (kind === 'wrapup') for (const x of sessions) x.b.emit('ConnectivityChanged', { online: false, transport: 'none' }).wait(31 * 60, 30);
    const ta = tok(sh, null);
    const tb = tok(sm2, ta.body.nonce);
    sm2.b.emit('PeerSighting', { sightingId: uuidv7(), kind, peer: ta, myNonce: tb.body.nonce });
    sh.b.emit('PeerSighting', { sightingId: uuidv7(), kind, peer: tb, myNonce: ta.body.nonce });
  }
  for (const x of sessions) {
    const evs = x.b.complete().build();
    const r = await http('POST', '/v1/sync/push', { protocolVersion: 1, deviceId: x.p.device.id, batchId: uuidv7(), sessions: [{ sessionId: x.b.sessionId, events: evs }] }, x.p.token);
    if (r.body.results?.[0]?.ackedThroughSeq !== evs.length) fail(`party push ${JSON.stringify(r.body)}`);
  }
  for (const x of sessions) await waitFor(async () => (await http('GET', `/v1/sessions/${x.b.sessionId}`, undefined, x.p.token)).body.verdict === 'verified', 'party verdict');
  const party = await waitFor(async () => {
    const r = (await http('GET', `/v1/parties/${ibody.partyId}`, undefined, pm.token)).body;
    return r?.goal?.reached ? r : null;
  }, 'party goal');
  if ((await http('GET', `/v1/parties/${ibody.partyId}`, undefined, token)).status !== 404) fail('party visible to a non-member');
  ok(`offline party (signed QR invite, 4 two-sided sightings, synced separately) → both verified; goal ${party.goal.total}/${party.goal.target} ${party.goal.label}; hidden from non-members`);

  console.log(`\n🎉 Smoke test passed: ${step} checks\n`);
}

main()
  .catch((e) => {
    console.error(`\n❌ Smoke test FAILED at step ${step + 1}: ${(e as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    proc.kill('SIGTERM');
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), 500);
  });
