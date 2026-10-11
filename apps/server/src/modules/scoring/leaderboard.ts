import type { ChallengeDefinition, LeaderboardDto } from '@trina/contracts';
import { aggregateTeam } from '@trina/engine';
import type { AppContext } from '../../platform/context';

type BestRow = { user_id: string; team_id: string | null; total_points: number; duration_s: number; completed: boolean; verdict: string; display_name: string };

/** Recomputes a challenge's leaderboard from final scores (best attempt per user). Cheap at MVP scale. */
export async function rebuildLeaderboard(ctx: AppContext, challengeId: string) {
  const c = await ctx.db.one<{ status: string; published_version: number | null; current_version: number }>(
    'SELECT status, published_version, current_version FROM challenges WHERE id = $1',
    [challengeId],
  );
  if (!c) return;
  // Leaderboard rules (ADR-028): a challenge using a taken-down module is excluded from every board.
  const removed = await ctx.db.one(
    `SELECT 1 FROM module_definitions d JOIN challenges ch ON d.id = ANY(ch.module_ids) WHERE ch.id = $1 AND d.status = 'taken_down' LIMIT 1`,
    [challengeId],
  );
  if (removed) {
    await ctx.db.query('DELETE FROM leaderboard_entries WHERE challenge_id = $1', [challengeId]);
    return;
  }
  const v = await ctx.db.one<{ definition: ChallengeDefinition }>('SELECT definition FROM challenge_versions WHERE challenge_id = $1 AND version = $2', [
    challengeId,
    c.published_version ?? c.current_version,
  ]);
  const best = await ctx.db.query<BestRow>(
    `SELECT DISTINCT ON (sc.user_id) sc.user_id, sc.team_id, sc.total_points, sc.duration_s, sc.completed, sc.verdict, u.display_name
     FROM scores sc JOIN users u ON u.id = sc.user_id
     WHERE sc.challenge_id = $1 AND sc.status = 'final' AND u.deleted_at IS NULL
     ORDER BY sc.user_id, sc.total_points DESC, sc.duration_s ASC`,
    [challengeId],
  );
  const sorted = [...best].sort((a, b) => b.total_points - a.total_points || a.duration_s - b.duration_s || a.user_id.localeCompare(b.user_id));
  const mode = v?.definition.scoring.teamAggregation ?? 'sum';
  const teams = new Map<string, BestRow[]>();
  for (const r of best) if (r.team_id) teams.set(r.team_id, [...(teams.get(r.team_id) ?? []), r]);
  const teamNames = new Map(
    (await ctx.db.query<{ id: string; name: string }>('SELECT id, name FROM teams WHERE challenge_id = $1', [challengeId])).map((t) => [t.id, t.name]),
  );
  const teamRows = [...teams.entries()]
    .map(([id, members]) => ({
      id,
      points: aggregateTeam(members.map((m) => m.total_points), mode),
      time: Math.max(...members.map((m) => m.duration_s)),
      level: members.every((m) => m.verdict === 'verified') ? 'verified' : 'verified_with_notes',
    }))
    .sort((a, b) => b.points - a.points || a.time - b.time);

  await ctx.db.tx(async (t) => {
    await t.query('DELETE FROM leaderboard_entries WHERE challenge_id = $1', [challengeId]);
    if (c.status === 'cancelled') return;
    let rank = 0;
    for (const r of sorted) {
      await t.query(
        `INSERT INTO leaderboard_entries (challenge_id, scope, subject_id, name, rank, points, completion_time_s, verified_level) VALUES ($1, 'individual', $2, $3, $4, $5, $6, $7)`,
        [challengeId, r.user_id, r.display_name, ++rank, r.total_points, r.completed ? r.duration_s : null, r.verdict === 'verified' ? 'verified' : 'verified_with_notes'],
      );
    }
    rank = 0;
    for (const tr of teamRows) {
      await t.query(
        `INSERT INTO leaderboard_entries (challenge_id, scope, subject_id, name, rank, points, completion_time_s, verified_level) VALUES ($1, 'team', $2, $3, $4, $5, $6, $7)`,
        [challengeId, tr.id, teamNames.get(tr.id) ?? 'Team', ++rank, tr.points, tr.time, tr.level],
      );
    }
  });
}

export async function leaderboard(ctx: AppContext, challengeId: string, scope: 'individual' | 'team'): Promise<LeaderboardDto> {
  const rows = await ctx.db.query<any>(
    'SELECT * FROM leaderboard_entries WHERE challenge_id = $1 AND scope = $2 ORDER BY rank LIMIT 100',
    [challengeId, scope],
  );
  const pending = await ctx.db.one<{ n: string }>(`SELECT count(*) AS n FROM scores WHERE challenge_id = $1 AND verdict = 'needs_review'`, [challengeId]);
  const updated = rows.reduce((m: string | null, r: any) => (!m || r.updated_at > m ? r.updated_at : m), null);
  return {
    challengeId,
    scope,
    entries: rows.map((r) => ({
      rank: r.rank,
      subjectId: r.subject_id,
      name: r.name,
      points: r.points,
      timeS: r.completion_time_s,
      verification: r.verified_level,
    })),
    pending: Number(pending?.n ?? 0),
    updatedAt: new Date(updated ?? ctx.now()).toISOString(),
  };
}
