import { PatchMeRequest } from '@trina/contracts';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../../platform/auth';
import type { AppContext } from '../../platform/context';
import { notFound, unauthorized } from '../../platform/errors';
import { iso, parseBody, parseQuery, uuidParam } from '../../platform/http';
import { verify as argonVerify } from '@node-rs/argon2';
import { toUserDto } from '../auth/routes';
import { sessionDto } from '../sync/sessions';

export function usersRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(requireAuth(ctx));

  r.get('/', async (req, res) => {
    const me = currentUser(req);
    const u = await ctx.db.one<any>('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [me.id]);
    if (!u) throw notFound('User');
    const stats = await ctx.db.one<{ sessions: string; points: string | null }>(
      `SELECT count(*) AS sessions, sum(total_points) AS points FROM scores WHERE user_id = $1 AND status = 'final'`,
      [me.id],
    );
    res.json({ user: toUserDto(u), stats: { sessions: Number(stats?.sessions ?? 0), points: Number(stats?.points ?? 0) } });
  });

  r.patch('/', async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(PatchMeRequest, req);
    const u = await ctx.db.one<any>(
      `UPDATE users SET display_name = COALESCE($2, display_name), share_wellbeing = COALESCE($3, share_wellbeing)
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [me.id, body.displayName ?? null, body.shareWellbeing ?? null],
    );
    if (!u) throw notFound('User');
    res.json({ user: toUserDto(u) });
  });

  r.delete('/', async (req, res) => {
    const me = currentUser(req);
    const { password } = parseBody(z.object({ password: z.string().min(1) }), req);
    const u = await ctx.db.one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [me.id]);
    if (!u || !(await argonVerify(u.password_hash, password).catch(() => false))) throw unauthorized('Password is incorrect', 'INVALID_CREDENTIALS');
    await ctx.db.tx(async (t) => {
      await t.query(`UPDATE users SET deleted_at = now(), email = 'deleted+' || id || '@trina.invalid' WHERE id = $1`, [me.id]);
      await t.query(`UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'account_deleted' WHERE user_id = $1`, [me.id]);
      await ctx.jobs.enqueue('purge-user', { userId: me.id }, { singletonKey: `purge-user:${me.id}`, delayMs: 30 * 86_400_000 }, t);
    });
    res.status(202).json({ status: 'scheduled', purgeAfterDays: 30 });
  });

  r.get('/devices', async (req, res) => {
    const me = currentUser(req);
    const rows = await ctx.db.query<any>(
      'SELECT id, platform, app_version, last_seen_at FROM devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY last_seen_at DESC',
      [me.id],
    );
    res.json(rows.map((d) => ({ id: d.id, platform: d.platform, appVersion: d.app_version, lastSeenAt: iso(d.last_seen_at), current: d.id === me.deviceId })));
  });

  r.delete('/devices/:id', async (req, res) => {
    const me = currentUser(req);
    const id = uuidParam(req, 'id');
    await ctx.db.tx(async (t) => {
      const d = await t.one('UPDATE devices SET revoked_at = now() WHERE id = $1 AND user_id = $2 RETURNING id', [id, me.id]);
      if (!d) throw notFound('Device');
      await t.query(`UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'device_revoked' WHERE device_id = $1 AND revoked_at IS NULL`, [id]);
    });
    res.status(204).end();
  });

  r.get('/sessions', async (req, res) => {
    const me = currentUser(req);
    const q = parseQuery(z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }), req);
    const rows = await ctx.db.query<{ id: string }>(
      'SELECT id FROM activity_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [me.id, q.limit],
    );
    const items = [];
    for (const row of rows) items.push(await sessionDto(ctx, row.id, { viewerId: me.id, includeMood: true }));
    res.json({ items });
  });

  r.get('/wellness', async (req, res) => {
    const me = currentUser(req);
    const q = parseQuery(z.object({ period: z.enum(['week', 'month', 'all']).default('week') }), req);
    const since = q.period === 'all' ? '1970-01-01' : new Date(ctx.now().getTime() - (q.period === 'week' ? 7 : 30) * 86_400_000).toISOString();
    const t = await ctx.db.one<any>(
      `SELECT count(*) AS sessions, coalesce(sum(w.steps),0) AS steps, coalesce(sum(sc.distance_m),0) AS distance_m,
              coalesce(sum(w.active_minutes),0) AS active_minutes, coalesce(sum(w.phone_free_minutes),0) AS phone_free_minutes,
              coalesce(sum(w.kcal_estimate),0) AS kcal
       FROM session_wellness w JOIN activity_sessions s ON s.id = w.session_id LEFT JOIN scores sc ON sc.session_id = s.id
       WHERE s.user_id = $1 AND s.created_at >= $2`,
      [me.id, since],
    );
    const share = await ctx.db.one<{ share_wellbeing: boolean }>('SELECT share_wellbeing FROM users WHERE id = $1', [me.id]);
    let moodTrend: { date: string; avgDelta: number }[] | undefined;
    if (share?.share_wellbeing) {
      const rows = await ctx.db.query<any>(
        `SELECT to_char(date_trunc('day', s.created_at), 'YYYY-MM-DD') AS d, avg(w.mood_after - w.mood_before) AS delta
         FROM session_wellness w JOIN activity_sessions s ON s.id = w.session_id
         WHERE s.user_id = $1 AND s.created_at >= $2 AND w.mood_before IS NOT NULL AND w.mood_after IS NOT NULL
         GROUP BY 1 ORDER BY 1`,
        [me.id, since],
      );
      moodTrend = rows.map((r) => ({ date: r.d, avgDelta: Math.round(Number(r.delta) * 10) / 10 }));
    }
    res.json({
      totals: {
        sessions: Number(t.sessions),
        steps: Number(t.steps),
        distanceM: Number(t.distance_m),
        activeMinutes: Number(t.active_minutes),
        phoneFreeMinutes: Number(t.phone_free_minutes),
        kcalEstimate: Number(t.kcal),
      },
      ...(moodTrend ? { moodTrend } : {}),
    });
  });

  return r;
}
