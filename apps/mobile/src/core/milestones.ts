import type { MilestoneStatus, ProgressDto, Verification, VerificationLabel } from '@trina/contracts';
import {
  buildMilestoneCatalog,
  dayKeyOf,
  defaultRegistry,
  ENGINE_VERSION,
  evaluateMilestones,
  levelTierForRank,
  pickDailyQuests,
  progression,
  unlocksOf,
  weekKeyOf,
  GENERIC_MILESTONES,
  type CompiledMilestone,
  type MilestoneProgress,
  type Progression,
  type SessionSummary,
} from '@trina/engine';
import type { OfflineStore } from './offline-store';
import { json, type SqlDb } from './sql';

/**
 * On-device milestones (design §7.3). Pure engine evaluation over local session summaries, so
 * unlocks appear OFFLINE right after a session; the server's final results replace them on sync.
 * Exactly once: one row per (milestone, window, tier) and a `notified` flag per row.
 */
export type LocalMilestone = {
  key: string;
  windowKey: string;
  tier: string;
  title: string;
  value: number;
  verification: Verification;
  label: VerificationLabel;
  stat: string;
  dayKey: string;
  status: MilestoneStatus;
  unlockedAt: string;
  /** Sessions this unlock came from (local evaluation). */
  sources: string[];
};

export function labelFor(v: Verification, status: MilestoneStatus = 'final'): VerificationLabel {
  if (status === 'pending_server') return 'Checked after sync';
  return v === 'sensor' ? 'Measured' : v === 'photo' ? 'Evidenced' : v === 'self_report' ? 'Self-reported' : 'Confirmed';
}

const TIER_ORDER = ['bronze', 'silver', 'gold'];

/** GET /v1/me/milestones returns at most this many rows (newest first); a full page may be truncated. */
export const SERVER_MILESTONE_LIST_LIMIT = 500;

type Row = { milestone_key: string; window_key: string; tier: string; title: string; value: number; verification: Verification; stat: string; day_key: string; status: MilestoneStatus; unlocked_at: string; notified: number; final_notified: number; sources_json: string };

const toLocal = (r: Row): LocalMilestone => ({
  key: r.milestone_key, windowKey: r.window_key, tier: r.tier, title: r.title, value: Number(r.value), verification: r.verification,
  label: labelFor(r.verification, r.status), stat: r.stat, dayKey: r.day_key, status: r.status, unlockedAt: r.unlocked_at, sources: json<string[]>(r.sources_json, []),
});

export class MilestoneService {
  constructor(
    private readonly db: SqlDb,
    private readonly store: OfflineStore,
    private readonly opts: { userId: string; now?: () => number },
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  async catalog(): Promise<CompiledMilestone[]> {
    const custom = await this.store.customModules();
    return buildMilestoneCatalog(custom.length ? defaultRegistry.with(custom.filter((m) => !defaultRegistry.get(m.id))) : defaultRegistry);
  }

  async saveSummary(s: SessionSummary, final = false) {
    await this.db.run(
      `INSERT INTO session_summaries (session_id, day_key, week_key, summary_json, final, engine_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET day_key = excluded.day_key, week_key = excluded.week_key, summary_json = excluded.summary_json,
         final = max(session_summaries.final, excluded.final), updated_at = excluded.updated_at`,
      [s.sessionId, s.dayKey, s.weekKey, JSON.stringify(s), final ? 1 : 0, ENGINE_VERSION, new Date(this.now()).toISOString()],
    );
  }

  async summaries(): Promise<SessionSummary[]> {
    const rows = await this.db.all<{ summary_json: string }>('SELECT summary_json FROM session_summaries ORDER BY day_key, session_id');
    // A shared phone may hold another account's sessions: only this player's count.
    return rows.map((r) => JSON.parse(r.summary_json) as SessionSummary).filter((s) => s.userId === this.opts.userId);
  }

  /**
   * Summaries for provisional views: every session on this phone counts as if verified, except
   * ones the server has already rejected (final verdict, not verified).
   */
  async provisionalSummaries(): Promise<SessionSummary[]> {
    const rows = await this.db.all<{ summary_json: string; final: number }>('SELECT summary_json, final FROM session_summaries ORDER BY day_key, session_id');
    return rows
      .map((r) => ({ s: JSON.parse(r.summary_json) as SessionSummary, final: Number(r.final) === 1 }))
      .filter((x) => x.s.userId === this.opts.userId && !(x.final && !x.s.verified))
      .map((x) => ({ ...x.s, verified: true }));
  }

  /** Provisional evaluation of everything on this phone. */
  async evaluate(): Promise<MilestoneProgress[]> {
    return evaluateMilestones(await this.catalog(), await this.provisionalSummaries(), { mode: 'provisional' });
  }

  /**
   * Re-evaluates and records NEW unlocks (rows that never existed). Server-final and revoked rows are
   * never downgraded or resurrected locally. Returns the unlocks that still need a notification.
   */
  async evaluateLocal(): Promise<LocalMilestone[]> {
    const progress = await this.evaluate();
    const at = new Date(this.now()).toISOString();
    await this.db.tx(async (t) => {
      for (const u of unlocksOf(progress)) {
        const p = progress.find((x) => x.key === u.key && x.windowKey === u.windowKey)!;
        await t.run(
          `INSERT INTO milestone_progress (milestone_key, window_key, tier, title, value, verification, stat, day_key, status, unlocked_at, sources_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'provisional', ?, ?)
           ON CONFLICT(milestone_key, window_key, tier) DO UPDATE SET value = excluded.value, sources_json = excluded.sources_json
             WHERE milestone_progress.status = 'provisional'`,
          [u.key, u.windowKey, u.tier, u.title, p.value, u.verification, u.stat, u.dayKey, at, JSON.stringify(p.sources)],
        );
      }
    });
    // Server-final rows are announced through newlyFinal(); here only new provisional unlocks.
    return (await this.db.all<Row>(`SELECT * FROM milestone_progress WHERE notified = 0 AND status = 'provisional' ORDER BY unlocked_at, milestone_key, tier`)).map(toLocal);
  }

  async markNotified(items: Array<Pick<LocalMilestone, 'key' | 'windowKey' | 'tier'>>) {
    for (const m of items) {
      await this.db.run('UPDATE milestone_progress SET notified = 1 WHERE milestone_key = ? AND window_key = ? AND tier = ?', [m.key, m.windowKey, m.tier]);
    }
  }

  /** Server-confirmed unlocks that were provisional and haven't had their "Confirmed" notice yet. */
  async newlyFinal(): Promise<LocalMilestone[]> {
    return (await this.db.all<Row>(`SELECT * FROM milestone_progress WHERE status = 'final' AND final_notified = 0 ORDER BY unlocked_at`)).map(toLocal);
  }

  async markFinalNotified(items: Array<Pick<LocalMilestone, 'key' | 'windowKey' | 'tier'>>) {
    for (const m of items) {
      await this.db.run('UPDATE milestone_progress SET final_notified = 1, notified = 1 WHERE milestone_key = ? AND window_key = ? AND tier = ?', [m.key, m.windowKey, m.tier]);
    }
  }

  /** Explicit revocations from a `milestones` pull change (`key|windowKey|tier`). */
  async revoke(keys: string[]) {
    for (const k of keys) {
      const [key, windowKey, tier] = k.split('|');
      if (!key || !windowKey || !tier) continue;
      await this.db.run(`UPDATE milestone_progress SET status = 'revoked' WHERE milestone_key = ? AND window_key = ? AND tier = ? AND status IN ('provisional','final')`, [key, windowKey, tier]);
    }
  }

  /**
   * Reconcile with the server's authoritative list (GET /v1/me/milestones). Server rows become
   * final; a local provisional row the server doesn't have is revoked once every session it came
   * from has a server verdict (the server evaluated it and disagreed). Others stay provisional.
   * The list is capped (newest first), so absence only means "revoked" when the list is complete;
   * otherwise only `revokedKeys` (from the pull change) revoke.
   */
  async reconcile(serverItems: Array<{ key: string; windowKey: string; tier: string; title: string; value: number; verification: string; stat: string; dayKey: string; unlockedAt: string | null }>, revokedKeys: string[] = []) {
    const at = new Date(this.now()).toISOString();
    const server = new Set<string>();
    const complete = serverItems.length < SERVER_MILESTONE_LIST_LIMIT;
    await this.revoke(revokedKeys);
    await this.db.tx(async (t) => {
      for (const it of serverItems) {
        const tiers = it.tier === 'unlock' ? ['unlock'] : TIER_ORDER.slice(0, TIER_ORDER.indexOf(it.tier) + 1);
        for (const tier of tiers) {
          server.add(`${it.key}|${it.windowKey}|${tier}`);
          await t.run(
            `INSERT INTO milestone_progress (milestone_key, window_key, tier, title, value, verification, stat, day_key, status, unlocked_at, notified, final_notified)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'final', ?, 0, 0)
             ON CONFLICT(milestone_key, window_key, tier) DO UPDATE SET status = 'final', value = excluded.value, verification = excluded.verification`,
            [it.key, it.windowKey, tier, it.title, it.value, it.verification, it.stat, it.dayKey, it.unlockedAt ?? at],
          );
        }
      }
      if (!complete) return;
      const local = await t.all<Row>(`SELECT * FROM milestone_progress WHERE status IN ('provisional','final')`);
      for (const r of local) {
        if (server.has(`${r.milestone_key}|${r.window_key}|${r.tier}`)) continue;
        if (r.status === 'final') {
          await t.run(`UPDATE milestone_progress SET status = 'revoked' WHERE milestone_key = ? AND window_key = ? AND tier = ?`, [r.milestone_key, r.window_key, r.tier]);
          continue;
        }
        const sources = json<string[]>(r.sources_json, []);
        if (!sources.length) continue;
        const decided = await t.get<{ n: number }>(`SELECT count(*) AS n FROM sessions WHERE id IN (${sources.map(() => '?').join(',')}) AND verdict IS NOT NULL`, sources);
        if (Number(decided?.n ?? 0) === sources.length) {
          await t.run(`UPDATE milestone_progress SET status = 'revoked' WHERE milestone_key = ? AND window_key = ? AND tier = ?`, [r.milestone_key, r.window_key, r.tier]);
        }
      }
    });
  }

  async applyProgress(p: ProgressDto) {
    await this.db.run(`INSERT INTO progress (id, json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`, [JSON.stringify(p), new Date(this.now()).toISOString()]);
  }

  /** Marks summaries final (or not) once the server verdict for a session is known. */
  async markSummaryFinal(sessionId: string, verified: boolean) {
    const r = await this.db.get<{ summary_json: string }>('SELECT summary_json FROM session_summaries WHERE session_id = ?', [sessionId]);
    if (!r) return;
    const s = { ...(JSON.parse(r.summary_json) as SessionSummary), verified };
    await this.db.run('UPDATE session_summaries SET summary_json = ?, final = 1 WHERE session_id = ?', [JSON.stringify(s), sessionId]);
  }

  /** Unlocks that came from one session (Completion screen). */
  async forSession(sessionId: string): Promise<LocalMilestone[]> {
    return (await this.all(['provisional', 'final'])).filter((m) => m.sources.includes(sessionId));
  }

  async all(status?: MilestoneStatus[]): Promise<LocalMilestone[]> {
    const rows = await this.db.all<Row>(`SELECT * FROM milestone_progress ORDER BY unlocked_at DESC, milestone_key, tier`);
    return rows.map(toLocal).filter((m) => !status || status.includes(m.status));
  }

  /** Server progress when known; provisional progression from this phone's summaries otherwise. */
  async progress(): Promise<{ server: ProgressDto | null; provisional: Progression }> {
    const row = await this.db.get<{ json: string }>('SELECT json FROM progress WHERE id = 1');
    const server = row ? (JSON.parse(row.json) as ProgressDto) : null;
    const summaries = await this.provisionalSummaries();
    const unlocks = (await this.all(['provisional', 'final'])).map((m) => ({ key: m.key, windowKey: m.windowKey, tier: m.tier as 'unlock', verification: m.verification, stat: m.stat as 'VIT', dayKey: m.dayKey, title: m.title }));
    // Provisional view: every local session not rejected by the server counts (labelled "provisional" in the UI).
    const provisional = progression({ unlocks, summaries, todayKey: this.todayKey(summaries), previousRank: server?.rank ?? null });
    return { server, provisional };
  }

  todayKey(summaries?: SessionSummary[]): string {
    const tz = summaries?.[summaries.length - 1]?.tzOffsetMin ?? -new Date(this.now()).getTimezoneOffset();
    return dayKeyOf(this.now(), tz);
  }

  /** Today's Daily Quests with progress (the same picks as GET /v1/me/quests, computed offline). */
  async dailyQuests(): Promise<{ dayKey: string; levelTier: string; targetMinutes: number; quests: Array<{ key: string; title: string; stat: string; value: number; target: number; done: boolean; status: MilestoneStatus | null }> }> {
    const summaries = await this.provisionalSummaries();
    const day = this.todayKey(summaries);
    const { server } = await this.progress();
    const level = levelTierForRank(server?.rank ?? 'E');
    const progress = evaluateMilestones(await this.catalog(), summaries, { mode: 'provisional' });
    const rows = await this.all();
    const byId = new Map(GENERIC_MILESTONES.map((m) => [m.id, m]));
    return {
      dayKey: day,
      levelTier: level.levelTier,
      targetMinutes: level.targetMinutes,
      quests: pickDailyQuests(this.opts.userId, day).map((id) => {
        const key = `*@1:${id}`;
        const def = byId.get(id)!;
        const p = progress.find((x) => x.key === key && x.windowKey === day);
        const row = rows.find((r) => r.key === key && r.windowKey === day);
        const target = def.tiers[def.tiers.length - 1]!.gte;
        return { key, title: def.title, stat: def.stat, value: p?.value ?? 0, target, done: !!p?.tier, status: row?.status ?? null };
      }),
    };
  }

  /** In-progress and unlocked milestones for today, this week and this month (Today screen). */
  async current(): Promise<MilestoneProgress[]> {
    const summaries = await this.provisionalSummaries();
    const day = this.todayKey(summaries);
    const week = weekKeyOf(day);
    return (await this.evaluate()).filter((p) => p.windowKey === day || p.windowKey === week || p.windowKey === day.slice(0, 7) || (p.window === 'session' && p.dayKey === day));
  }
}
