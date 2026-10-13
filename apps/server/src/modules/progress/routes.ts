import { RegisterDeviceKeyRequest, type DailyQuestDto, type MilestoneCatalogItemDto, type ProgressDto, type Rank, type Stat, type Verification } from '@trina/contracts';
import {
  adaptQuest,
  RANK_MAX_MINUTES,
  type SessionSummary,
  buildMilestoneCatalog,
  DAILY_XP_CAP,
  dayKeyOf,
  defaultRegistry,
  ENGINE_VERSION,
  GENERIC_MILESTONES,
  levelTierForRank,
  monthKeyOf,
  pickDailyQuests,
  RANK_THRESHOLDS,
  RANKS,
  weekKeyOf,
} from '@trina/engine';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAuth } from '../../platform/auth';
import type { AppContext } from '../../platform/context';
import { conflict } from '../../platform/errors';
import { iso, parseBody, parseQuery } from '../../platform/http';
import { canView, compileStored, getModule, getModuleVersion } from '../datamodules/service';
import { verificationLabel } from './service';

const DateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function progressRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(['/milestones', '/me/milestones', '/me/progress', '/me/quests', '/me/devices/current'], requireAuth(ctx));

  /** Milestone catalogue: generic quests + built-in/official modules, or one custom module the caller may see. */
  r.get('/milestones', async (req, res) => {
    const me = currentUser(req);
    const q = parseQuery(z.object({ moduleId: z.string().regex(/^(\*|[a-z][a-z0-9_]{1,31})$/).optional(), version: z.coerce.number().int().min(1).optional() }), req);
    let registry = defaultRegistry;
    if (q.moduleId && q.moduleId !== '*' && !defaultRegistry.get(q.moduleId)) {
      const m = await getModule(ctx.db, q.moduleId);
      if (!canView(m, me)) {
        res.json([]);
        return;
      }
      registry = defaultRegistry.with([compileStored(await getModuleVersion(ctx.db, q.moduleId, q.version ?? m.current_version))]);
    }
    const items: MilestoneCatalogItemDto[] = buildMilestoneCatalog(registry)
      .filter((m) => !q.moduleId || m.moduleId === q.moduleId)
      .map((m) => ({
        key: m.key,
        moduleId: m.moduleId,
        milestoneId: m.def.id,
        title: m.def.title,
        description: m.def.description ?? null,
        window: m.def.window,
        tiers: m.def.tiers,
        verification: m.verification,
        stat: m.def.stat,
        hidden: m.def.hidden,
      }));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json(items);
  });

  r.get('/me/milestones', async (req, res) => {
    const me = currentUser(req);
    const q = parseQuery(z.object({ window: z.enum(['day', 'week', 'month', 'lifetime', 'all']).default('all'), date: DateKey.optional() }), req);
    const day = q.date ?? dayKeyOf(ctx.now().getTime(), 0);
    const windowKey = q.window === 'day' ? day : q.window === 'week' ? weekKeyOf(day) : q.window === 'month' ? monthKeyOf(day) : q.window === 'lifetime' ? 'life' : null;
    type Row = { milestone_key: string; window_key: string; tier: string; title: string; value: number; verification: Verification; stat: string; day_key: string; unlocked_at: string };
    const rows = await ctx.db.query<Row>(
      `SELECT * FROM user_milestones WHERE user_id = $1 AND status = 'final' AND ($2::text IS NULL OR window_key = $2) ORDER BY unlocked_at DESC LIMIT 500`,
      [me.id, windowKey],
    );
    res.json({
      windowKey,
      items: rows.map((m) => ({
        key: m.milestone_key,
        windowKey: m.window_key,
        tier: m.tier,
        title: m.title,
        value: Number(m.value),
        verification: m.verification,
        label: verificationLabel(m.verification),
        stat: m.stat,
        dayKey: m.day_key,
        unlockedAt: iso(m.unlocked_at),
      })),
    });
  });

  r.get('/me/progress', async (req, res) => {
    const me = currentUser(req);
    const p = await ctx.db.one<{ xp: number; xp_by_stat: Record<Stat, number> | null; rank_points: number; rank: Rank; verified_outdoor_minutes: number; offline_quest_minutes: number; daily_xp: Record<string, number> | null; weeks: Record<string, { bonus: number; penalty: number; forceStopDays: number; offline90Days: number }> | null }>('SELECT * FROM user_progress WHERE user_id = $1', [me.id]);
    const today = dayKeyOf(ctx.now().getTime(), 0);
    const wk = weekKeyOf(today);
    const week = p?.weeks?.[wk];
    const rank = (p?.rank ?? 'E') as Rank;
    const next = RANKS[RANKS.indexOf(rank) + 1];
    const dto: ProgressDto = {
      xp: p?.xp ?? 0,
      xpByStat: (p?.xp_by_stat as Record<Stat, number>) ?? { VIT: 0, AGI: 0, STR: 0, SENSE: 0, AURA: 0 },
      rankPoints: p?.rank_points ?? 0,
      rank,
      nextRank: next ? { rank: next, rankPoints: RANK_THRESHOLDS[next] } : null,
      verifiedOutdoorMinutes: p?.verified_outdoor_minutes ?? 0,
      offlineQuestMinutes: p?.offline_quest_minutes ?? 0,
      todayXp: Number(p?.daily_xp?.[today] ?? 0),
      dailyXpCap: DAILY_XP_CAP,
      week: { weekKey: wk, bonus: week?.bonus ?? 0, penalty: week?.penalty ?? 0, forceStopDays: week?.forceStopDays ?? 0, offline90Days: week?.offline90Days ?? 0 },
      engineVersion: ENGINE_VERSION,
    };
    res.json(dto);
  });

  /** Today's 3 Daily Quests (deterministic; the phone computes the same list offline). */
  r.get('/me/quests', async (req, res) => {
    const me = currentUser(req);
    const q = parseQuery(z.object({ date: DateKey.optional() }), req);
    const day = q.date ?? dayKeyOf(ctx.now().getTime(), 0);
    const p = await ctx.db.one<{ rank: Rank }>('SELECT rank FROM user_progress WHERE user_id = $1', [me.id]);
    const rank = p?.rank ?? 'E';
    const level = levelTierForRank(rank);
    // Adaptive length (ADR-032) from VERIFIED quest history; the phone computes the same from its own view.
    const history = await ctx.db.query<{ summary: SessionSummary }>(
      `SELECT summary FROM session_summaries WHERE user_id = $1 AND verified = true AND day_key >= $2 AND day_key <= $3`,
      [me.id, dayKeyOf(Date.parse(`${day}T00:00:00Z`) - 21 * 86_400_000, 0), day],
    );
    const adapted = adaptQuest(history.map((h) => h.summary), { rank, todayKey: day });
    const byId = new Map(GENERIC_MILESTONES.map((m) => [m.id, m]));
    const dto: DailyQuestDto = {
      dayKey: day,
      levelTier: level.levelTier,
      targetMinutes: adapted.targetMinutes,
      targetReason: adapted.reason,
      maxMinutes: RANK_MAX_MINUTES[rank],
      quests: pickDailyQuests(me.id, day).map((id) => ({ key: `*@1:${id}`, title: byId.get(id)!.title, stat: byId.get(id)!.stat as Stat })),
    };
    res.json(dto);
  });

  /** Registers this device's Ed25519 public key (once per install; ADR-026). */
  r.put('/me/devices/current/key', async (req, res) => {
    const me = currentUser(req);
    const body = parseBody(RegisterDeviceKeyRequest, req);
    const d = await ctx.db.one<{ public_key: string | null }>('SELECT public_key FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [me.deviceId, me.id]);
    if (!d) throw conflict('CONFLICT', 'Device not registered');
    if (d.public_key && d.public_key !== body.publicKey) throw conflict('CONFLICT', 'This device already has a different key');
    await ctx.db.query('UPDATE devices SET public_key = $3 WHERE id = $1 AND user_id = $2', [me.deviceId, me.id, body.publicKey]);
    res.status(204).end();
  });

  return r;
}
