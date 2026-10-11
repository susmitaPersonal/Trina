import { randomInt } from 'node:crypto';
import { checkSafety, CreateGuildRequest, CreateInviteRequest, JoinGuildRequest, nameKey, uuidv7, type GuildBoardDto, type GuildDto } from '@trina/contracts';
import { dayKeyOf, weekKeyOf, type SessionSummary } from '@trina/engine';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../../platform/auth';
import type { AppContext } from '../../platform/context';
import { conflict, forbidden, HttpError, notFound } from '../../platform/errors';
import { parseBody, parseQuery, uuidParam } from '../../platform/http';
import { idempotent, limiter } from '../../platform/middleware';

export const MAX_GUILDS_PER_PLAYER = 5;
export const GUILD_QUEST_TARGET_MIN = 600;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

type Role = 'leader' | 'officer' | 'member';

async function membership(ctx: AppContext, guildId: string, userId: string) {
  return ctx.db.one<{ role: Role }>('SELECT role FROM guild_members WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
}

/** Guilds (ADR-031, demo cut: create, invite by code/QR, join, leave, weekly board + Guild Quest). */
export function guildsRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(['/guilds', '/me/guilds'], requireAuth(ctx));

  r.get('/me/guilds', async (req, res) => {
    const me = currentUser(req);
    const rows = await ctx.db.query<{ id: string; name: string; icon: string; role: string; members: string | number }>(
      `SELECT g.id, g.name, g.icon, gm.role, (SELECT count(*) FROM guild_members x WHERE x.guild_id = g.id) AS members
       FROM guild_members gm JOIN guilds g ON g.id = gm.guild_id WHERE gm.user_id = $1 AND g.status = 'active' ORDER BY g.name`,
      [me.id],
    );
    res.json({ items: rows.map((g) => ({ id: g.id, name: g.name, icon: g.icon, role: g.role, members: Number(g.members) })) });
  });

  r.post('/guilds', limiter(ctx, { windowMs: 86_400_000, limit: 2, key: 'user' }), idempotent(ctx), async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(CreateGuildRequest, req);
    const risk = checkSafety([body.name, body.description]);
    if (risk.level === 'blocked') throw new HttpError(422, 'MODULE_UNSAFE', `That guild name isn't allowed: ${risk.findings[0]?.message ?? 'not allowed'}`);
    const count = await ctx.db.one<{ n: string }>('SELECT count(*) AS n FROM guild_members WHERE user_id = $1', [me.id]);
    if (Number(count?.n ?? 0) >= MAX_GUILDS_PER_PLAYER) throw new HttpError(429, 'QUOTA_EXCEEDED', `You can be in up to ${MAX_GUILDS_PER_PLAYER} guilds`);
    const id = uuidv7();
    await ctx.db.tx(async (t) => {
      const taken = await t.one('SELECT 1 FROM guilds WHERE name_key = $1', [nameKey(body.name)]);
      if (taken) throw conflict('CONFLICT', 'That guild name is taken');
      await t.query('INSERT INTO guilds (id, name, name_key, description, icon, leader_id) VALUES ($1, $2, $3, $4, $5, $6)', [id, body.name, nameKey(body.name), body.description, body.icon, me.id]);
      await t.query(`INSERT INTO guild_members (guild_id, user_id, role) VALUES ($1, $2, 'leader')`, [id, me.id]);
    });
    res.status(201).json({ id, name: body.name });
  });

  r.get('/guilds/:id', async (req, res) => {
    const me = currentUser(req);
    const id = uuidParam(req, 'id');
    const mine = await membership(ctx, id, me.id);
    if (!mine && me.role !== 'admin') throw notFound('Guild');
    const g = await ctx.db.one<{ name: string; description: string; icon: string; member_limit: number }>(`SELECT * FROM guilds WHERE id = $1 AND status = 'active'`, [id]);
    if (!g) throw notFound('Guild');
    const members = await ctx.db.query<{ user_id: string; role: Role; display_name: string; rank: string }>(
      `SELECT gm.user_id, gm.role, u.display_name, COALESCE(p.rank, 'E') AS rank FROM guild_members gm JOIN users u ON u.id = gm.user_id
       LEFT JOIN user_progress p ON p.user_id = gm.user_id WHERE gm.guild_id = $1 ORDER BY gm.role, u.display_name`,
      [id],
    );
    const dto: GuildDto = {
      id, name: g.name, description: g.description, icon: g.icon, memberLimit: g.member_limit,
      members: members.map((m) => ({ userId: m.user_id, displayName: m.display_name, role: m.role, rank: m.rank })),
      myRole: mine?.role ?? null,
    };
    res.json(dto);
  });

  r.post('/guilds/:id/invites', async (req, res) => {
    const me = currentUser(req);
    const id = uuidParam(req, 'id');
    const mine = await membership(ctx, id, me.id);
    if (!mine || mine.role === 'member') throw forbidden('Only leaders and officers can invite');
    const body = parseBody(CreateInviteRequest, req);
    const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    const expires = new Date(ctx.now().getTime() + 7 * 86_400_000).toISOString();
    await ctx.db.query('INSERT INTO guild_invites (code, guild_id, created_by, expires_at, max_uses) VALUES ($1, $2, $3, $4, $5)', [code, id, me.id, expires, body.maxUses]);
    res.status(201).json({ code, expiresAt: expires });
  });

  r.post('/guilds/join', idempotent(ctx), async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(JoinGuildRequest, req);
    const out = await ctx.db.tx(async (t) => {
      const inv = await t.one<{ guild_id: string; expires_at: string; max_uses: number; uses: number }>('SELECT * FROM guild_invites WHERE code = $1 FOR UPDATE', [body.code]);
      if (!inv || new Date(inv.expires_at) <= ctx.now() || inv.uses >= inv.max_uses) throw new HttpError(410, 'INVITE_EXPIRED', 'This invite has expired');
      const existing = await t.one('SELECT 1 FROM guild_members WHERE guild_id = $1 AND user_id = $2', [inv.guild_id, me.id]);
      if (existing) return { guildId: inv.guild_id, created: false };
      const n = await t.one<{ n: string; limit: number }>('SELECT count(*) AS n, (SELECT member_limit FROM guilds WHERE id = $1) AS limit FROM guild_members WHERE guild_id = $1', [inv.guild_id]);
      if (Number(n?.n ?? 0) >= Number(n?.limit ?? 50)) throw new HttpError(409, 'GUILD_FULL', 'This guild is full');
      const mineCount = await t.one<{ n: string }>('SELECT count(*) AS n FROM guild_members WHERE user_id = $1', [me.id]);
      if (Number(mineCount?.n ?? 0) >= MAX_GUILDS_PER_PLAYER) throw new HttpError(429, 'QUOTA_EXCEEDED', `You can be in up to ${MAX_GUILDS_PER_PLAYER} guilds`);
      await t.query(`INSERT INTO guild_members (guild_id, user_id, role) VALUES ($1, $2, 'member')`, [inv.guild_id, me.id]);
      await t.query('UPDATE guild_invites SET uses = uses + 1 WHERE code = $1', [body.code]);
      return { guildId: inv.guild_id, created: true };
    });
    res.status(out.created ? 201 : 200).json({ guildId: out.guildId });
  });

  r.post('/guilds/:id/leave', async (req, res) => {
    const me = currentUser(req);
    const id = uuidParam(req, 'id');
    const mine = await membership(ctx, id, me.id);
    if (!mine) {
      res.status(204).end();
      return;
    }
    if (mine.role === 'leader') {
      const others = await ctx.db.one<{ n: string }>('SELECT count(*) AS n FROM guild_members WHERE guild_id = $1 AND user_id <> $2', [id, me.id]);
      if (Number(others?.n ?? 0) > 0) throw conflict('CONFLICT', 'Hand over leadership before leaving');
    }
    await ctx.db.query('DELETE FROM guild_members WHERE guild_id = $1 AND user_id = $2', [id, me.id]);
    res.status(204).end();
  });

  /** Weekly board: XP (from progression) and verified offline quest minutes; members only. */
  r.get('/guilds/:id/board', async (req, res) => {
    const me = currentUser(req);
    const id = uuidParam(req, 'id');
    if (!(await membership(ctx, id, me.id))) throw notFound('Guild');
    const q = parseQuery(z.object({ period: z.enum(['week', 'season']).default('week') }), req);
    const weekKey = weekKeyOf(dayKeyOf(ctx.now().getTime(), 0));
    const members = await ctx.db.query<{ user_id: string; display_name: string; daily_xp: Record<string, number> | null }>(
      `SELECT gm.user_id, u.display_name, p.daily_xp FROM guild_members gm JOIN users u ON u.id = gm.user_id
       LEFT JOIN user_progress p ON p.user_id = gm.user_id WHERE gm.guild_id = $1 AND gm.share_timeline`,
      [id],
    );
    const sums = await ctx.db.query<{ user_id: string; summary: SessionSummary }>(
      `SELECT s.user_id, s.summary FROM session_summaries s JOIN guild_members gm ON gm.user_id = s.user_id AND gm.guild_id = $1
       WHERE s.verified AND ($2 = 'season' OR s.week_key = $3)`,
      [id, q.period, weekKey],
    );
    const offline = new Map<string, number>();
    for (const s of sums) if (s.summary.isQuest) offline.set(s.user_id, (offline.get(s.user_id) ?? 0) + Math.floor(Number(s.summary.facts.offline_s ?? 0) / 60));
    const entries = members
      .map((m) => ({
        userId: m.user_id,
        displayName: m.display_name,
        xp: Object.entries(m.daily_xp ?? {}).filter(([d]) => q.period === 'season' || weekKeyOf(d) === weekKey).reduce((n, [, v]) => n + Number(v), 0),
        offlineMinutes: offline.get(m.user_id) ?? 0,
      }))
      .sort((a, b) => b.xp - a.xp || b.offlineMinutes - a.offlineMinutes || a.displayName.localeCompare(b.displayName));
    const dto: GuildBoardDto = {
      guildId: id,
      period: q.period,
      weekKey,
      entries,
      guildQuest: { title: `Guild reaches ${GUILD_QUEST_TARGET_MIN} offline minutes together`, target: GUILD_QUEST_TARGET_MIN, value: entries.reduce((n, e) => n + e.offlineMinutes, 0) },
    };
    res.json(dto);
  });

  return r;
}
