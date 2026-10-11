import {
  BundleDto,
  CreateChallengeRequest,
  JoinRequest,
  ListChallengesQuery,
  PatchChallengeRequest,
  PublishRequest,
  uuidv7,
  type ChallengeDetail,
} from '@trina/contracts';
import { compileOrThrow } from '@trina/engine';
import { bundleModules, customRefs, registryForDefinition } from '../datamodules/service';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../../platform/auth';
import type { AppContext } from '../../platform/context';
import { badRequest, conflict, forbidden, notFound } from '../../platform/errors';
import { parseBody, parseQuery, uuidParam } from '../../platform/http';
import { idempotent } from '../../platform/middleware';
import { leaderboard } from '../scoring/leaderboard';
import {
  assertCanView,
  assertCreator,
  bundleExtras,
  createChallenge,
  getChallenge,
  getVersion,
  participantCount,
  participation,
  toSummary,
  updateChallenge,
  type ChallengeRow,
} from './service';

export function modulesRouter(ctx: AppContext): Router {
  const r = Router();
  const auth = requireAuth(ctx);
  r.get('/templates', auth, async (req, res) => {
    const q = parseQuery(z.object({ module: z.string().optional() }), req);
    const rows = await ctx.db.query<any>(
      `SELECT id, title, description, module_ids, definition FROM challenge_templates
       WHERE $1::text IS NULL OR $1 = ANY(module_ids) ORDER BY created_at`,
      [q.module ?? null],
    );
    res.json({ items: rows.map((t) => ({ id: t.id, title: t.title, description: t.description, moduleIds: t.module_ids, definition: t.definition })) });
  });
  return r;
}

export function challengesRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(requireAuth(ctx));

  r.get('/', async (req, res) => {
    const me = currentUser(req);
    const q = parseQuery(ListChallengesQuery, req);
    const offset = q.cursor ? Number.parseInt(Buffer.from(q.cursor, 'base64url').toString(), 10) || 0 : 0;
    let near: [number, number] | undefined;
    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (q.mine === 'created') where.push(`c.creator_id = ${p(me.id)}`);
    else if (q.mine === 'joined') where.push(`EXISTS (SELECT 1 FROM challenge_participants cp WHERE cp.challenge_id = c.id AND cp.user_id = ${p(me.id)} AND cp.status = 'joined')`);
    else where.push(`c.status = 'published' AND c.visibility = 'public'`);
    if (q.module) where.push(`${p(q.module)} = ANY(c.module_ids)`);
    if (q.difficulty) where.push(`c.difficulty = ${p(q.difficulty)}`);
    if (q.maxDuration) where.push(`c.duration_min <= ${p(q.maxDuration)}`);
    if (q.near) {
      const [lat, lng] = q.near.split(',').map(Number) as [number, number];
      near = [lng, lat];
      const dLat = q.radiusKm / 111;
      const dLng = q.radiusKm / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
      where.push(`c.start_lat BETWEEN ${p(lat - dLat)} AND ${p(lat + dLat)} AND c.start_lng BETWEEN ${p(lng - dLng)} AND ${p(lng + dLng)}`);
    }
    const rows = await ctx.db.query<ChallengeRow>(
      `SELECT c.* FROM challenges c WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC LIMIT 200`,
      params,
    );
    let summaries = await Promise.all(rows.map((c) => toSummary(ctx.db, c, near)));
    if (near) summaries = summaries.filter((s) => (s.distanceKm ?? 0) <= q.radiusKm).sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
    const page = summaries.slice(offset, offset + q.limit);
    const next = offset + q.limit < summaries.length ? Buffer.from(String(offset + q.limit)).toString('base64url') : null;
    res.json({ items: page, nextCursor: next });
  });

  r.post('/', idempotent(ctx, { required: true }), async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(CreateChallengeRequest, req);
    const created = await createChallenge(ctx, me.id, body.definition, body.aiGenerationId, me.role);
    res.status(201).json({ id: created.id, version: created.version, status: created.status, maxScore: created.maxScore, validation: { issues: created.issues } });
  });

  r.get('/:id', async (req, res) => {
    const me = currentUser(req);
    const c = await getChallenge(ctx.db, uuidParam(req, 'id'));
    await assertCanView(ctx.db, c, me);
    const v = await getVersion(ctx.db, c.id, c.current_version);
    const compiled = compileOrThrow(v.definition, await registryForDefinition(ctx.db, v.definition));
    const part = await participation(ctx.db, c.id, me.id);
    const teams = await ctx.db.query<any>(
      `SELECT t.id, t.name, count(cp.user_id) AS members FROM teams t
       LEFT JOIN challenge_participants cp ON cp.team_id = t.id AND cp.status = 'joined'
       WHERE t.challenge_id = $1 GROUP BY t.id, t.name ORDER BY t.name`,
      [c.id],
    );
    const detail: ChallengeDetail = {
      challenge: await toSummary(ctx.db, c),
      definition: compiled.definition,
      definitionHash: v.definition_hash,
      maxScore: v.max_score,
      myParticipation: part ? { status: part.status, teamId: part.team_id, joinedVersion: part.joined_version } : null,
      teams: teams.map((t) => ({ id: t.id, name: t.name, members: Number(t.members) })),
      isCreator: c.creator_id === me.id,
    };
    res.json(detail);
  });

  r.patch('/:id', async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(PatchChallengeRequest, req);
    const out = await updateChallenge(ctx, me, uuidParam(req, 'id'), body.definition, body.baseVersion);
    res.json({ version: out.version, maxScore: out.maxScore, validation: { issues: out.issues } });
  });

  r.post('/:id/publish', async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(PublishRequest, req);
    const id = uuidParam(req, 'id');
    await ctx.db.tx(async (t) => {
      const c = await t.one<ChallengeRow>('SELECT * FROM challenges WHERE id = $1 FOR UPDATE', [id]);
      if (!c) throw notFound('Challenge');
      assertCreator(c, me);
      if (c.status === 'published' && c.published_version === body.version) return;
      if (c.status !== 'draft' && c.status !== 'published') throw conflict('CONFLICT', `Challenge is ${c.status}`);
      if (body.version !== c.current_version) throw conflict('STALE_VERSION', 'Publish the latest version');
      if (c.closes_at && new Date(c.closes_at) <= ctx.now()) throw conflict('WINDOW_CLOSED', 'Challenge window has already closed');
      // Custom modules must be published (active) before a challenge using them can go live.
      const v = await getVersion(t, id, body.version);
      for (const ref of customRefs(v.definition)) {
        const m = await t.one<{ status: string; display_name: string }>('SELECT status, display_name FROM module_definitions WHERE id = $1', [ref.id]);
        if (!m || m.status !== 'active') throw conflict('MODULE_TAKEN_DOWN', `Publish the module "${m?.display_name ?? ref.id}" first`);
      }
      await t.query(`UPDATE challenges SET status = 'published', published_version = $2, updated_at = now() WHERE id = $1`, [id, body.version]);
    });
    res.json({ status: 'published', version: body.version });
  });

  r.post('/:id/cancel', async (req, res) => {
    const me = currentUser(req);
    const { reason } = parseBody(z.object({ reason: z.string().max(200).default('') }), req);
    const c = await getChallenge(ctx.db, uuidParam(req, 'id'));
    assertCreator(c, me);
    await ctx.db.query(`UPDATE challenges SET status = 'cancelled', updated_at = now() WHERE id = $1`, [c.id]);
    await ctx.db.query(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1, $2, 'cancel', 'challenge', $3, $4)`, [
      uuidv7(), me.id, c.id, JSON.stringify({ reason }),
    ]);
    res.json({ status: 'cancelled' });
  });

  r.post('/:id/join', idempotent(ctx), async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(JoinRequest, req);
    const id = uuidParam(req, 'id');
    const result = await ctx.db.tx(async (t) => {
      const c = await t.one<ChallengeRow>('SELECT * FROM challenges WHERE id = $1 FOR UPDATE', [id]);
      if (!c) throw notFound('Challenge');
      await assertCanView(t, c, me);
      if (c.status !== 'published' || !c.published_version) throw conflict('NOT_PUBLISHED', 'Challenge is not open for joining');
      if (c.closes_at && new Date(c.closes_at) <= ctx.now()) throw conflict('WINDOW_CLOSED', 'Challenge window has closed');
      const existing = await participation(t, id, me.id);
      if (existing?.status === 'joined') return { created: false, teamId: existing.team_id, joinedVersion: existing.joined_version };
      if ((await participantCount(t, id)) >= c.max_participants) throw conflict('CHALLENGE_FULL', 'Challenge is full');
      const v = await getVersion(t, id, c.published_version);
      let teamId: string | null = null;
      if (v.definition.mode === 'team') {
        if (body.teamId) {
          const team = await t.one<{ id: string }>('SELECT id FROM teams WHERE id = $1 AND challenge_id = $2', [body.teamId, id]);
          if (!team) throw badRequest('Unknown team');
          const sizeMax = v.definition.participants.teams?.sizeMax ?? 50;
          const members = await t.one<{ n: string }>(`SELECT count(*) AS n FROM challenge_participants WHERE team_id = $1 AND status = 'joined'`, [team.id]);
          if (Number(members?.n ?? 0) >= sizeMax) throw conflict('CHALLENGE_FULL', 'Team is full');
          teamId = team.id;
        } else {
          const name = body.newTeamName ?? `Team ${uuidv7().slice(-4)}`;
          const maxTeams = v.definition.participants.teams?.count ?? 50;
          const nTeams = await t.one<{ n: string }>('SELECT count(*) AS n FROM teams WHERE challenge_id = $1', [id]);
          if (Number(nTeams?.n ?? 0) >= maxTeams) throw conflict('CHALLENGE_FULL', 'No more teams can be created; join an existing team');
          const team = await t.one<{ id: string }>('INSERT INTO teams (id, challenge_id, name, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (challenge_id, name) DO NOTHING RETURNING id', [
            uuidv7(), id, name, me.id,
          ]);
          if (!team) throw conflict('CONFLICT', 'Team name already taken');
          teamId = team.id;
        }
      }
      await t.query(
        `INSERT INTO challenge_participants (challenge_id, user_id, team_id, joined_version, status) VALUES ($1, $2, $3, $4, 'joined')
         ON CONFLICT (challenge_id, user_id) DO UPDATE SET status = 'joined', team_id = EXCLUDED.team_id, joined_version = EXCLUDED.joined_version, joined_at = now()`,
        [id, me.id, teamId, c.published_version],
      );
      return { created: true, teamId, joinedVersion: c.published_version };
    });
    res.status(result.created ? 201 : 200).json({ participation: { status: 'joined', teamId: result.teamId }, joinedVersion: result.joinedVersion });
  });

  r.post('/:id/leave', async (req, res) => {
    const me = currentUser(req);
    await ctx.db.query(`UPDATE challenge_participants SET status = 'withdrawn' WHERE challenge_id = $1 AND user_id = $2`, [uuidParam(req, 'id'), me.id]);
    res.status(204).end();
  });

  r.get('/:id/versions/:v/bundle', async (req, res) => {
    const me = currentUser(req);
    const id = uuidParam(req, 'id');
    const version = Number.parseInt(String(req.params.v), 10);
    if (!Number.isInteger(version) || version < 1) throw badRequest('Invalid version');
    const c = await getChallenge(ctx.db, id);
    const part = await participation(ctx.db, id, me.id);
    if (!part || part.status !== 'joined') throw forbidden('Join the challenge first');
    if (version !== part.joined_version && version !== c.published_version) throw notFound('Challenge version');
    const v = await getVersion(ctx.db, id, version);
    if (version !== part.joined_version) {
      await ctx.db.query('UPDATE challenge_participants SET joined_version = $3 WHERE challenge_id = $1 AND user_id = $2', [id, me.id, version]);
    }
    const compiled = compileOrThrow(v.definition, await registryForDefinition(ctx.db, v.definition));
    const extras = bundleExtras(compiled, ctx.config.TILES_URL);
    // Participants' device keys (latest registered, not revoked): offline confirmation checks (ADR-026).
    const keys = await ctx.db.query<{ user_id: string; device_id: string; public_key: string; display_name: string }>(
      `SELECT DISTINCT ON (d.user_id) d.user_id, d.id AS device_id, d.public_key, u.display_name
       FROM challenge_participants cp JOIN devices d ON d.user_id = cp.user_id JOIN users u ON u.id = d.user_id
       WHERE cp.challenge_id = $1 AND cp.status = 'joined' AND d.public_key IS NOT NULL AND d.revoked_at IS NULL
       ORDER BY d.user_id, d.last_seen_at DESC`,
      [id],
    );
    const bundle = BundleDto.parse({
      challengeId: id,
      version,
      definition: compiled.definition,
      definitionHash: v.definition_hash,
      engineMinVersion: v.engine_min_version,
      maxScore: v.max_score,
      ...extras,
      participation: { teamId: part.team_id, joinedVersion: version },
      serverTime: ctx.now().toISOString(),
      modules: await bundleModules(ctx.db, v.definition),
      participantKeys: keys.map((k) => ({ userId: k.user_id, deviceId: k.device_id, publicKey: k.public_key, displayName: k.display_name })),
    });
    res.setHeader('ETag', `"${v.definition_hash.slice(0, 16)}-${version}"`);
    res.json(bundle);
  });

  r.get('/:id/leaderboard', async (req, res) => {
    const me = currentUser(req);
    const q = parseQuery(z.object({ scope: z.enum(['individual', 'team']).default('individual') }), req);
    const c = await getChallenge(ctx.db, uuidParam(req, 'id'));
    await assertCanView(ctx.db, c, me);
    res.json(await leaderboard(ctx, c.id, q.scope));
  });

  r.get('/:id/impact', async (req, res) => {
    const me = currentUser(req);
    const q = parseQuery(z.object({ format: z.enum(['json', 'csv']).default('json') }), req);
    const c = await getChallenge(ctx.db, uuidParam(req, 'id'));
    assertCreator(c, me);
    const s = await ctx.db.one<any>(
      `SELECT count(DISTINCT s.user_id) AS participants,
              count(*) FILTER (WHERE sc.status = 'final') AS verified_sessions,
              coalesce(sum(sc.distance_m) FILTER (WHERE sc.status = 'final'), 0) AS distance_m,
              coalesce(sum(w.steps) FILTER (WHERE sc.status = 'final'), 0) AS steps,
              coalesce(sum(w.kcal_estimate) FILTER (WHERE sc.status = 'final'), 0) AS kcal
       FROM activity_sessions s LEFT JOIN scores sc ON sc.session_id = s.id LEFT JOIN session_wellness w ON w.session_id = s.id
       WHERE s.challenge_id = $1`,
      [c.id],
    );
    const tasks = await ctx.db.query<any>(
      `SELECT e.payload->>'taskId' AS task_id, count(*) AS n FROM activity_events e
       JOIN activity_sessions s ON s.id = e.session_id JOIN scores sc ON sc.session_id = s.id AND sc.status = 'final'
       WHERE s.challenge_id = $1 AND e.type = 'TaskCompleted' GROUP BY 1`,
      [c.id],
    );
    const mood = await ctx.db.one<any>(
      `SELECT count(*) AS n, avg(w.mood_after - w.mood_before) AS delta FROM session_wellness w
       JOIN activity_sessions s ON s.id = w.session_id WHERE s.challenge_id = $1 AND w.mood_before IS NOT NULL AND w.mood_after IS NOT NULL`,
      [c.id],
    );
    const impact = {
      challengeId: c.id,
      title: c.title,
      participants: Number(s.participants),
      verifiedSessions: Number(s.verified_sessions),
      distanceM: Number(s.distance_m),
      steps: Number(s.steps),
      kcalEstimate: Number(s.kcal),
      tasks: Object.fromEntries(tasks.map((t) => [t.task_id, Number(t.n)])),
      // Aggregated mood only with ≥ 5 opted-in participants (privacy).
      avgMoodDelta: Number(mood?.n ?? 0) >= 5 ? Math.round(Number(mood.delta) * 10) / 10 : null,
      note: 'Verified by automated checks. Calories are estimates.',
    };
    if (q.format === 'csv') {
      const rows = [
        ['metric', 'value'],
        ['participants', impact.participants],
        ['verified_sessions', impact.verifiedSessions],
        ['distance_m', impact.distanceM],
        ['steps', impact.steps],
        ['kcal_estimate', impact.kcalEstimate],
        ...Object.entries(impact.tasks).map(([k, v]) => [`task_${k}_completed`, v]),
        ['avg_mood_delta', impact.avgMoodDelta ?? ''],
      ];
      res.type('text/csv').send(rows.map((r) => r.join(',')).join('\n'));
      return;
    }
    res.json(impact);
  });

  return r;
}
