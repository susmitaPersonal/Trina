import { definitionHash, uuidv7, type ChallengeDefinition, type ChallengeSummary, type CompileIssue } from '@trina/contracts';
import { bboxOf, compile, DAILY_QUEST_CHALLENGE_ID, PARTY_CHALLENGE_ID, ENGINE_VERSION, haversineM, renderRules, type CompiledChallenge, type ModuleRegistry } from '@trina/engine';
import { registryForDefinition } from '../datamodules/service';
import type { AppContext } from '../../platform/context';
import type { Db } from '../../platform/db';
import { conflict, forbidden, HttpError, notFound } from '../../platform/errors';
import { iso } from '../../platform/http';

export type ChallengeRow = {
  id: string;
  creator_id: string;
  status: 'draft' | 'published' | 'cancelled' | 'archived';
  visibility: 'public' | 'unlisted' | 'private';
  title: string;
  current_version: number;
  published_version: number | null;
  start_lng: number;
  start_lat: number;
  opens_at: string | null;
  closes_at: string | null;
  difficulty: 'easy' | 'medium' | 'hard';
  module_ids: string[];
  duration_min: number;
  max_participants: number;
  created_at: string;
};

export type VersionRow = { challenge_id: string; version: number; definition: ChallengeDefinition; definition_hash: string; max_score: number; engine_min_version: number };

export function compileOrFail(input: unknown, registry?: ModuleRegistry): { compiled: CompiledChallenge; issues: CompileIssue[]; maxScore: number } {
  const r = compile(input, registry);
  if (!r.ok) throw new HttpError(422, 'COMPILE_FAILED', 'Challenge definition is not valid', r.issues.filter((i) => i.severity === 'error'));
  return { compiled: r.compiled, issues: r.issues, maxScore: r.maxScore };
}

/** Compiles a definition with the custom modules it pins (and checks the creator may use them). */
export async function compileFor(db: Db, input: unknown, user?: { id: string; role: string }) {
  const registry = await registryForDefinition(db, input, user ? { forCreator: user } : {});
  return { ...compileOrFail(input, registry), registry };
}

export async function getChallenge(db: Db, id: string): Promise<ChallengeRow> {
  if (id === DAILY_QUEST_CHALLENGE_ID || id === PARTY_CHALLENGE_ID) throw notFound('Challenge'); // anchor rows for offline quests/parties, never shown
  const c = await db.one<ChallengeRow>('SELECT * FROM challenges WHERE id = $1', [id]);
  if (!c) throw notFound('Challenge');
  return c;
}

export async function getVersion(db: Db, id: string, version: number): Promise<VersionRow> {
  const v = await db.one<VersionRow>('SELECT * FROM challenge_versions WHERE challenge_id = $1 AND version = $2', [id, version]);
  if (!v) throw notFound('Challenge version');
  return v;
}

export async function participation(db: Db, challengeId: string, userId: string) {
  return db.one<{ status: string; team_id: string | null; joined_version: number }>(
    'SELECT status, team_id, joined_version FROM challenge_participants WHERE challenge_id = $1 AND user_id = $2',
    [challengeId, userId],
  );
}

/** Visibility rules: drafts → creator; private → creator/participants/admin; others → anyone signed in. */
export async function assertCanView(db: Db, c: ChallengeRow, user: { id: string; role: string }) {
  if (user.role === 'admin' || c.creator_id === user.id) return;
  if (c.status === 'draft') throw notFound('Challenge');
  if (c.visibility === 'private') {
    const p = await participation(db, c.id, user.id);
    if (!p) throw notFound('Challenge');
  }
}

export function assertCreator(c: ChallengeRow, user: { id: string; role: string }) {
  if (c.creator_id !== user.id && user.role !== 'admin') throw forbidden('Only the creator can do this');
}

async function writeVersion(t: Db, challengeId: string, version: number, def: ChallengeDefinition, maxScore: number, userId: string, aiGenerationId?: string) {
  await t.query(
    `INSERT INTO challenge_versions (challenge_id, version, definition, definition_hash, max_score, engine_min_version, created_by, ai_generation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (challenge_id, version) DO UPDATE SET definition = EXCLUDED.definition, definition_hash = EXCLUDED.definition_hash,
       max_score = EXCLUDED.max_score, created_at = now()`,
    [challengeId, version, JSON.stringify(def), definitionHash(def), maxScore, ENGINE_VERSION, userId, aiGenerationId ?? null],
  );
  await t.query('DELETE FROM challenge_checkpoints WHERE challenge_id = $1 AND version = $2', [challengeId, version]);
  let ord = 0;
  for (const cp of def.checkpoints) {
    await t.query(
      'INSERT INTO challenge_checkpoints (challenge_id, version, checkpoint_id, ord, lng, lat, radius_m) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [challengeId, version, cp.id, ord++, cp.geometry.center[0], cp.geometry.center[1], cp.geometry.radiusM],
    );
  }
}

function rowFields(def: ChallengeDefinition) {
  return {
    title: def.meta.title,
    visibility: def.meta.visibility,
    difficulty: def.meta.difficulty,
    start_lng: def.area.startZone.center[0],
    start_lat: def.area.startZone.center[1],
    opens_at: def.timing.window?.opensAt ?? null,
    closes_at: def.timing.window?.closesAt ?? null,
    module_ids: def.modules.map((m) => m.id),
    duration_min: def.timing.durationMin,
    max_participants: def.participants.max,
  };
}

export async function createChallenge(ctx: AppContext, userId: string, input: unknown, aiGenerationId?: string, role = 'user') {
  const { compiled, issues, maxScore } = await compileFor(ctx.db, input, { id: userId, role });
  const def = compiled.definition;
  const id = uuidv7();
  const f = rowFields(def);
  await ctx.db.tx(async (t) => {
    await t.query(
      `INSERT INTO challenges (id, creator_id, status, visibility, title, current_version, start_lng, start_lat, opens_at, closes_at,
         difficulty, module_ids, duration_min, max_participants)
       VALUES ($1, $2, 'draft', $3, $4, 1, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, userId, f.visibility, f.title, f.start_lng, f.start_lat, f.opens_at, f.closes_at, f.difficulty, f.module_ids, f.duration_min, f.max_participants],
    );
    await writeVersion(t, id, 1, def, maxScore, userId, aiGenerationId);
    if (aiGenerationId) await t.query('UPDATE ai_generations SET accepted = true, challenge_id = $2 WHERE id = $1 AND user_id = $3', [aiGenerationId, id, userId]);
  });
  return { id, version: 1, status: 'draft' as const, issues, maxScore };
}

export async function updateChallenge(ctx: AppContext, user: { id: string; role: string }, id: string, input: unknown, baseVersion: number) {
  const { compiled, issues, maxScore } = await compileFor(ctx.db, input, user);
  const def = compiled.definition;
  return ctx.db.tx(async (t) => {
    const c = await t.one<ChallengeRow>('SELECT * FROM challenges WHERE id = $1 FOR UPDATE', [id]);
    if (!c) throw notFound('Challenge');
    assertCreator(c, user);
    if (c.status === 'cancelled' || c.status === 'archived') throw conflict('CONFLICT', `Challenge is ${c.status}`);
    if (baseVersion !== c.current_version) throw conflict('STALE_VERSION', `Challenge is at version ${c.current_version}; reload and retry`);
    // Drafts are edited in place; published challenges get an immutable new version.
    const version = c.status === 'draft' ? c.current_version : c.current_version + 1;
    await writeVersion(t, id, version, def, maxScore, user.id);
    const f = rowFields(def);
    await t.query(
      `UPDATE challenges SET current_version = $2, title = $3, visibility = $4, difficulty = $5, start_lng = $6, start_lat = $7,
         opens_at = $8, closes_at = $9, module_ids = $10, duration_min = $11, max_participants = $12,
         published_version = CASE WHEN status = 'published' THEN $2 ELSE published_version END, updated_at = now()
       WHERE id = $1`,
      [id, version, f.title, f.visibility, f.difficulty, f.start_lng, f.start_lat, f.opens_at, f.closes_at, f.module_ids, f.duration_min, f.max_participants],
    );
    if (c.status === 'published') {
      const participants = await t.query<{ user_id: string }>(`SELECT user_id FROM challenge_participants WHERE challenge_id = $1 AND status = 'joined'`, [id]);
      for (const p of participants) {
        await t.query(`INSERT INTO user_changes (user_id, kind, ref_id, data) VALUES ($1, 'challenge_version', $2, $3)`, [
          p.user_id, id, JSON.stringify({ challengeId: id, version, status: 'published' }),
        ]);
      }
    }
    return { version, issues, maxScore };
  });
}

export async function participantCount(db: Db, challengeId: string): Promise<number> {
  const r = await db.one<{ n: string }>(`SELECT count(*) AS n FROM challenge_participants WHERE challenge_id = $1 AND status = 'joined'`, [challengeId]);
  return Number(r?.n ?? 0);
}

export async function toSummary(db: Db, c: ChallengeRow, near?: [number, number]): Promise<ChallengeSummary> {
  const creator = await db.one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [c.creator_id]);
  return {
    id: c.id,
    title: c.title,
    status: c.status,
    visibility: c.visibility,
    difficulty: c.difficulty,
    moduleIds: c.module_ids,
    durationMin: c.duration_min,
    startPoint: [c.start_lng, c.start_lat],
    distanceKm: near ? Math.round(haversineM(near, [c.start_lng, c.start_lat]) / 100) / 10 : null,
    opensAt: iso(c.opens_at),
    closesAt: iso(c.closes_at),
    participants: await participantCount(db, c.id),
    maxParticipants: c.max_participants,
    creatorName: creator?.display_name ?? 'Unknown',
    currentVersion: c.current_version,
  };
}

/** Deterministic fallback encouragement (AI-written lines can replace these at bundle time). */
export function encouragementLines(compiled: CompiledChallenge): { trigger: string; text: string }[] {
  const n = compiled.checkpoints.size;
  const lines = [
    { trigger: 'start', text: 'You are off! Phone in pocket, eyes up. 🌱' },
    { trigger: 'checkpoint', text: 'Checkpoint reached. Nice and steady.' },
    { trigger: 'halfway', text: `Halfway there${n ? `: ${Math.ceil(n / 2)} of ${n} checkpoints done` : ''}. Breathe and enjoy the green.` },
    { trigger: 'task_done', text: 'Task done. Your neighbourhood says thank you!' },
    { trigger: 'last_ten_minutes', text: 'Ten minutes left. No rush, stay safe.' },
    { trigger: 'finish', text: 'Challenge complete! Take a moment, how do you feel?' },
  ];
  if ([...compiled.tasks.values()].some((t) => t.type.startsWith('tree_care'))) {
    lines.push({ trigger: 'task_done', text: 'That tree just got a drink. 🌳' });
  }
  return lines;
}

export function bundleExtras(compiled: CompiledChallenge, tilesUrl?: string) {
  const d = compiled.definition;
  const pts = [d.area.startZone.center, ...d.checkpoints.map((c) => c.geometry.center)];
  if (d.area.endZone) pts.push(d.area.endZone.center);
  return {
    mapPack: tilesUrl ? { url: tilesUrl, bbox: bboxOf(pts, 500) } : null,
    ruleText: renderRules(compiled),
    encouragement: encouragementLines(compiled),
  };
}
