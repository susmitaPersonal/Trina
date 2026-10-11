import { PullResponse, PushRequest, PushResponse } from '@trina/contracts';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../../platform/auth';
import type { AppContext } from '../../platform/context';
import { forbidden } from '../../platform/errors';
import { parseBody, parseQuery, uuidParam } from '../../platform/http';
import { limiter } from '../../platform/middleware';
import { ingestPush } from './ingest';
import { sessionDto } from './sessions';

export function syncRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(requireAuth(ctx));

  r.post('/push', limiter(ctx, { windowMs: 60_000, limit: 60, key: 'user' }), async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(PushRequest, req);
    const results = await ingestPush(ctx, me.id, body);
    res.json(PushResponse.parse({ batchId: body.batchId, serverTime: ctx.now().toISOString(), results }));
  });

  r.get('/pull', async (req, res) => {
    const me = currentUser(req);
    const q = parseQuery(z.object({ cursor: z.string().regex(/^\d{1,18}$/).default('0'), limit: z.coerce.number().int().min(1).max(200).default(100) }), req);
    const rows = await ctx.db.query<{ id: string; kind: string; ref_id: string; data: any }>(
      'SELECT id, kind, ref_id, data FROM user_changes WHERE user_id = $1 AND id > $2 ORDER BY id LIMIT $3',
      [me.id, q.cursor, q.limit],
    );
    const cursor = rows.length ? String(rows[rows.length - 1]!.id) : q.cursor;
    res.json(
      PullResponse.parse({
        changes: rows.map((r) => ({ kind: r.kind, id: r.ref_id, data: r.data })),
        cursor,
        serverTime: ctx.now().toISOString(),
      }),
    );
  });

  return r;
}

export function sessionsRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(requireAuth(ctx));

  r.get('/:id', async (req, res) => {
    const me = currentUser(req);
    const id = uuidParam(req, 'id');
    const s = await ctx.db.one<{ user_id: string; creator_id: string }>(
      'SELECT s.user_id, c.creator_id FROM activity_sessions s JOIN challenges c ON c.id = s.challenge_id WHERE s.id = $1',
      [id],
    );
    if (!s || (s.user_id !== me.id && s.creator_id !== me.id && me.role !== 'admin')) throw forbidden('Not your session');
    res.json(await sessionDto(ctx, id, { viewerId: me.id, includeMood: s.user_id === me.id }));
  });

  // Opt-in mood check-in (1–5). Not part of the hash chain; never affects score.
  r.put('/:id/mood', async (req, res) => {
    const me = currentUser(req);
    const id = uuidParam(req, 'id');
    const body = parseBody(z.object({ moodBefore: z.int().min(1).max(5).nullable().optional(), moodAfter: z.int().min(1).max(5).nullable().optional() }), req);
    const s = await ctx.db.one<{ user_id: string; mood_json: Record<string, number | null> | null }>('SELECT user_id, mood_json FROM activity_sessions WHERE id = $1', [id]);
    if (!s || s.user_id !== me.id) throw forbidden('Not your session');
    const u = await ctx.db.one<{ share_wellbeing: boolean }>('SELECT share_wellbeing FROM users WHERE id = $1', [me.id]);
    if (!u?.share_wellbeing) {
      res.status(204).end(); // silently dropped: user has not opted in
      return;
    }
    const mood = { ...(s.mood_json ?? {}), ...body };
    await ctx.db.query('UPDATE activity_sessions SET mood_json = $2 WHERE id = $1', [id, JSON.stringify(mood)]);
    await ctx.db.query('UPDATE session_wellness SET mood_before = COALESCE($2, mood_before), mood_after = COALESCE($3, mood_after) WHERE session_id = $1', [
      id, mood.moodBefore ?? null, mood.moodAfter ?? null,
    ]);
    res.status(204).end();
  });

  r.delete('/:id/track', async (req, res) => {
    const me = currentUser(req);
    const id = uuidParam(req, 'id');
    const s = await ctx.db.one<{ user_id: string }>('SELECT user_id FROM activity_sessions WHERE id = $1', [id]);
    if (!s || s.user_id !== me.id) throw forbidden('Not your session');
    await ctx.db.tx(async (t) => {
      await t.query(`UPDATE activity_events SET payload = '{"samples":[]}'::jsonb, redacted = true WHERE session_id = $1 AND type = 'LocationBatch'`, [id]);
      await t.query('DELETE FROM session_tracks WHERE session_id = $1', [id]);
      await t.query('UPDATE activity_sessions SET track_deleted_at = now() WHERE id = $1', [id]);
    });
    res.status(204).end();
  });

  return r;
}
