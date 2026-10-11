import type { MilestoneProgressDto, ProgressDto, Rank, Verification, VerificationLabel } from '@trina/contracts';
import {
  buildMilestoneCatalog,
  coPresence,
  dayKeyOf,
  defaultRegistry,
  ENGINE_VERSION,
  evaluateMilestones,
  progression,
  unlocksOf,
  weekKeyOf,
  DAILY_XP_CAP,
  type MilestoneProgress,
  type ModuleDef,
  type SessionSummary,
} from '@trina/engine';
import type { AppContext } from '../../platform/context';
import { compileStored, type ModuleVersionRow } from '../datamodules/service';

export function verificationLabel(v: Verification, pending = false): VerificationLabel {
  if (pending) return 'Checked after sync';
  return v === 'sensor' ? 'Measured' : v === 'photo' ? 'Evidenced' : v === 'self_report' ? 'Self-reported' : 'Confirmed';
}

export function progressDto(p: MilestoneProgress, status: MilestoneProgressDto['status'], unlockedAt: string | null): MilestoneProgressDto {
  return {
    key: p.key,
    moduleId: p.moduleId,
    milestoneId: p.milestoneId,
    title: p.title,
    windowKey: p.windowKey,
    tier: p.tier,
    value: p.value,
    nextTier: p.nextTier,
    verification: p.verification,
    label: verificationLabel(p.verification, p.pendingServer),
    stat: p.stat,
    status,
    unlockedAt,
  };
}

/** Registry with the custom module versions a set of summaries used (latest version per id). */
export async function registryForSummaries(ctx: AppContext, summaries: SessionSummary[]) {
  const wanted = new Map<string, number>();
  for (const s of summaries) for (const [id, v] of Object.entries(s.moduleVersions ?? {})) if (!defaultRegistry.get(id)) wanted.set(id, Math.max(wanted.get(id) ?? 0, v));
  const extra: ModuleDef[] = [];
  for (const [id, v] of wanted) {
    const row = await ctx.db.one<ModuleVersionRow>('SELECT * FROM module_versions WHERE module_id = $1 AND version = $2', [id, v]);
    if (row) extra.push(compileStored(row));
  }
  return extra.length ? defaultRegistry.with(extra) : defaultRegistry;
}

export async function loadSummaries(ctx: AppContext, userId: string): Promise<SessionSummary[]> {
  const rows = await ctx.db.query<{ summary: SessionSummary }>('SELECT summary FROM session_summaries WHERE user_id = $1 ORDER BY day_key, session_id', [userId]);
  return rows.map((r) => r.summary);
}

/**
 * Authoritative milestone + progression evaluation for one player (job `evaluate-milestones`).
 * Exactly once: one row per (user, milestone, window, tier); re-running never duplicates, and rows
 * whose sessions were later rejected become `revoked` (and come back if re-approved).
 */
export async function evaluateUser(ctx: AppContext, userId: string) {
  const summaries = await loadSummaries(ctx, userId);
  const verified = summaries.filter((s) => s.verified);
  // Co-presence needs other players' verified sessions of the same challenges on the same days.
  const challengeIds = [...new Set(verified.map((s) => s.challengeId))];
  const days = [...new Set(verified.map((s) => s.dayKey))];
  const others = challengeIds.length
    ? (await ctx.db.query<{ summary: SessionSummary }>('SELECT summary FROM session_summaries WHERE challenge_id = ANY($1) AND day_key = ANY($2) AND verified', [challengeIds, days])).map((r) => r.summary)
    : [];
  const together = coPresence(others);
  const serverFacts: Record<string, Record<string, number>> = {};
  for (const s of verified) serverFacts[s.sessionId] = { 'copresence.max_players': together[s.sessionId] ?? 1 };

  const catalog = buildMilestoneCatalog(await registryForSummaries(ctx, summaries));
  const progress = evaluateMilestones(catalog, summaries, { mode: 'final', serverFacts });
  const unlocks = unlocksOf(progress);
  const prev = await ctx.db.one<{ rank: Rank; xp: number; rank_points: number }>('SELECT rank, xp, rank_points FROM user_progress WHERE user_id = $1', [userId]);
  const latest = summaries[summaries.length - 1];
  const todayKey = dayKeyOf(ctx.now().getTime(), latest?.tzOffsetMin ?? 0);
  const prog = progression({ unlocks, summaries, todayKey, previousRank: prev?.rank ?? null });

  const byKey = new Map(progress.map((p) => [`${p.key}|${p.windowKey}`, p]));
  const changed: MilestoneProgressDto[] = [];
  const revokedKeys: string[] = [];
  await ctx.db.tx(async (t) => {
    const existing = await t.query<{ milestone_key: string; window_key: string; tier: string; status: string; value: number; unlocked_at: string }>(
      'SELECT milestone_key, window_key, tier, status, value, unlocked_at FROM user_milestones WHERE user_id = $1',
      [userId],
    );
    const have = new Map(existing.map((r) => [`${r.milestone_key}|${r.window_key}|${r.tier}`, r]));
    const now = new Set<string>();
    for (const u of unlocks) {
      const id = `${u.key}|${u.windowKey}|${u.tier}`;
      now.add(id);
      const p = byKey.get(`${u.key}|${u.windowKey}`)!;
      const row = have.get(id);
      if (!row || row.status !== 'final' || Number(row.value) !== p.value) {
        const ins = await t.one<{ unlocked_at: string }>(
          `INSERT INTO user_milestones (user_id, milestone_key, window_key, tier, title, value, verification, stat, day_key, status, source_sessions, engine_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'final', $10, $11)
           ON CONFLICT (user_id, milestone_key, window_key, tier) DO UPDATE SET status = 'final', value = EXCLUDED.value, source_sessions = EXCLUDED.source_sessions, updated_at = now()
           RETURNING unlocked_at`,
          [userId, u.key, u.windowKey, u.tier, u.title, p.value, u.verification, u.stat, u.dayKey, p.sources, ENGINE_VERSION],
        );
        if (!changed.some((c) => c.key === p.key && c.windowKey === p.windowKey)) changed.push(progressDto(p, 'final', new Date(ins?.unlocked_at ?? ctx.now()).toISOString()));
      }
    }
    for (const r of existing) {
      const id = `${r.milestone_key}|${r.window_key}|${r.tier}`;
      if (r.status === 'final' && !now.has(id)) {
        await t.query(`UPDATE user_milestones SET status = 'revoked', updated_at = now() WHERE user_id = $1 AND milestone_key = $2 AND window_key = $3 AND tier = $4`, [userId, r.milestone_key, r.window_key, r.tier]);
        revokedKeys.push(id);
      }
    }
    await t.query(
      `INSERT INTO user_progress (user_id, xp, xp_by_stat, rank_points, rank, verified_outdoor_minutes, offline_quest_minutes, daily_xp, weeks, engine_version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (user_id) DO UPDATE SET xp = EXCLUDED.xp, xp_by_stat = EXCLUDED.xp_by_stat, rank_points = EXCLUDED.rank_points, rank = EXCLUDED.rank,
         verified_outdoor_minutes = EXCLUDED.verified_outdoor_minutes, offline_quest_minutes = EXCLUDED.offline_quest_minutes, daily_xp = EXCLUDED.daily_xp,
         weeks = EXCLUDED.weeks, engine_version = EXCLUDED.engine_version, updated_at = now()`,
      [userId, prog.xp, JSON.stringify(prog.xpByStat), prog.rankPoints, prog.rank, prog.verifiedOutdoorMinutes, prog.offlineQuestMinutes, JSON.stringify(prog.dailyXp), JSON.stringify(prog.weeks), ENGINE_VERSION],
    );
    if (changed.length || revokedKeys.length) {
      await t.query(`INSERT INTO user_changes (user_id, kind, ref_id, data) VALUES ($1, 'milestones', $1, $2)`, [userId, JSON.stringify({ items: changed.slice(0, 500), revokedKeys: revokedKeys.slice(0, 500) })]);
    }
    if (!prev || prev.xp !== prog.xp || prev.rank !== prog.rank || prev.rank_points !== prog.rankPoints || changed.length || revokedKeys.length) {
      await t.query(`INSERT INTO user_changes (user_id, kind, ref_id, data) VALUES ($1, 'progress', $1, $2)`, [userId, JSON.stringify(toProgressDto(prog, todayKey))]);
    }
  });
  return { unlocks: unlocks.length, changed: changed.length, revoked: revokedKeys.length, xp: prog.xp, rank: prog.rank };
}

export function toProgressDto(prog: ReturnType<typeof progression>, todayKey: string): ProgressDto {
  const wk = weekKeyOf(todayKey);
  const w = prog.weeks[wk];
  return {
    xp: prog.xp,
    xpByStat: prog.xpByStat,
    rankPoints: prog.rankPoints,
    rank: prog.rank,
    nextRank: prog.nextRank,
    verifiedOutdoorMinutes: prog.verifiedOutdoorMinutes,
    offlineQuestMinutes: prog.offlineQuestMinutes,
    todayXp: prog.todayXp,
    dailyXpCap: DAILY_XP_CAP,
    week: { weekKey: wk, bonus: w?.bonus ?? 0, penalty: w?.penalty ?? 0, forceStopDays: w?.forceStopDays ?? 0, offline90Days: w?.offline90Days ?? 0 },
    engineVersion: ENGINE_VERSION,
  };
}
