import { uuidv7 } from '@trina/contracts';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAdmin, requireAuth } from '../../platform/auth';
import type { AppContext } from '../../platform/context';
import { notFound } from '../../platform/errors';
import { parseBody, parseQuery, uuidParam } from '../../platform/http';
import { rebuildLeaderboard } from '../scoring/leaderboard';
import { sessionDto } from '../sync/sessions';

export function adminRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(requireAuth(ctx), requireAdmin());

  r.get('/flags', async (req, res) => {
    const q = parseQuery(z.object({ status: z.enum(['open', 'all']).default('open') }), req);
    const rows = await ctx.db.query<any>(
      `SELECT s.id AS session_id, s.challenge_id, c.title, s.validation_status, u.display_name,
              json_agg(json_build_object('code', f.code, 'severity', f.severity, 'message', f.message) ORDER BY f.created_at) AS flags
       FROM activity_sessions s JOIN challenges c ON c.id = s.challenge_id JOIN users u ON u.id = s.user_id
       JOIN session_flags f ON f.session_id = s.id
       WHERE ($1 = 'all' OR s.validation_status = 'needs_review')
       GROUP BY s.id, c.title, u.display_name ORDER BY s.last_received_at DESC LIMIT 100`,
      [q.status],
    );
    res.json({ items: rows });
  });

  r.get('/sessions/:id', async (req, res) => {
    const me = currentUser(req);
    const id = uuidParam(req, 'id');
    const dto = await sessionDto(ctx, id, { viewerId: me.id, includeMood: false });
    const track = await ctx.db.one<{ simplified: unknown }>('SELECT simplified FROM session_tracks WHERE session_id = $1', [id]);
    const evidence = await ctx.db.query<any>('SELECT id, task_id, upload_status FROM evidence WHERE session_id = $1', [id]);
    const events = await ctx.db.query<any>(`SELECT seq, type, client_ts, mono_ms FROM activity_events WHERE session_id = $1 ORDER BY seq`, [id]);
    await ctx.db.query(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id) VALUES ($1, $2, 'view_session', 'session', $3)`, [uuidv7(), me.id, id]);
    res.json({ session: dto, track: track?.simplified ?? null, evidence, timeline: events });
  });

  r.post('/sessions/:id/review', async (req, res) => {
    const me = currentUser(req);
    const id = uuidParam(req, 'id');
    const body = parseBody(z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(500).default('') }), req);
    const s = await ctx.db.one<{ challenge_id: string; user_id: string }>('SELECT challenge_id, user_id FROM activity_sessions WHERE id = $1', [id]);
    if (!s) throw notFound('Session');
    const verdict = body.decision === 'approve' ? 'verified' : 'rejected';
    await ctx.db.tx(async (t) => {
      await t.query('UPDATE activity_sessions SET validation_status = $2 WHERE id = $1', [id, verdict]);
      await t.query(`UPDATE scores SET status = $2, verdict = $3 WHERE session_id = $1`, [id, body.decision === 'approve' ? 'final' : 'rejected', verdict]);
      await t.query(`UPDATE session_flags SET resolved_by = $2, resolution = $3 WHERE session_id = $1 AND resolved_by IS NULL`, [id, me.id, body.decision]);
      await t.query(
        `INSERT INTO validation_runs (id, session_id, engine_version, pipeline_version, verdict, started_at) VALUES ($1, $2, 0, 0, $3, now())`,
        [uuidv7(), id, verdict],
      );
      await t.query(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1, $2, 'review', 'session', $3, $4)`, [
        uuidv7(), me.id, id, JSON.stringify(body),
      ]);
      const score = await t.one<any>('SELECT total_points, completed, breakdown FROM scores WHERE session_id = $1', [id]);
      await t.query(`INSERT INTO user_changes (user_id, kind, ref_id, data) VALUES ($1, 'session_result', $2, $3)`, [
        s.user_id,
        id,
        JSON.stringify({
          sessionId: id, challengeId: s.challenge_id, verdict, totalPoints: score?.total_points ?? 0, completed: score?.completed ?? false,
          breakdown: score?.breakdown ?? [], flags: [], wellness: null,
        }),
      ]);
    });
    // Milestones follow the human decision (approve → counts; reject → revoked on next evaluation).
    await ctx.db.query('UPDATE session_summaries SET verified = $2, summary = jsonb_set(summary, \'{verified}\', to_jsonb($2::boolean)) WHERE session_id = $1', [id, body.decision === 'approve']);
    await ctx.jobs.enqueue('evaluate-milestones', { userId: s.user_id }, { singletonKey: `milestones:${s.user_id}` });
    await rebuildLeaderboard(ctx, s.challenge_id);
    res.json({ verdict });
  });

  r.post('/challenges/:id/takedown', async (req, res) => {
    const me = currentUser(req);
    const id = uuidParam(req, 'id');
    const body = parseBody(z.object({ reason: z.string().min(3).max(500) }), req);
    const c = await ctx.db.one(`UPDATE challenges SET status = 'archived', updated_at = now() WHERE id = $1 RETURNING id`, [id]);
    if (!c) throw notFound('Challenge');
    await ctx.db.query(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1, $2, 'takedown', 'challenge', $3, $4)`, [
      uuidv7(), me.id, id, JSON.stringify(body),
    ]);
    await rebuildLeaderboard(ctx, id);
    res.json({ status: 'archived' });
  });

  return r;
}
