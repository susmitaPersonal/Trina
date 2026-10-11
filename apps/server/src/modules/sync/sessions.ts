import type { SessionDto } from '@trina/contracts';
import type { AppContext } from '../../platform/context';
import { notFound } from '../../platform/errors';
import { iso } from '../../platform/http';

/** User-safe flag messages: neutral language, never accusatory. */
export const FLAG_MESSAGES: Record<string, string> = {
  SEQ_GAP: 'Some activity data is missing.',
  CHAIN_BROKEN: 'Activity data could not be verified as unchanged.',
  DUP_ID_DIFF_HASH: 'Some activity data was received twice with different content.',
  DEFINITION_MISMATCH: 'The challenge rules on the device did not match.',
  OUTSIDE_WINDOW: 'The session happened outside the challenge window.',
  FUTURE_EVENT: 'Some timestamps were later than when we received them.',
  CLOCK_DRIFT: "The phone's clock changed during the session.",
  MOCK_LOCATION: 'A simulated (mock) location was detected.',
  LOCATION_JUMP: 'Some GPS points jumped implausibly and were ignored.',
  START_OUTSIDE_ZONE: 'The session did not start inside the start zone.',
  CP_MANUAL: 'A checkpoint was confirmed manually because GPS was weak.',
  EVIDENCE_MISSING: 'A photo was never uploaded, so its task could not be counted.',
  EVIDENCE_DUPLICATE: 'A photo matches one submitted before.',
  EVIDENCE_OFF_LOCATION: 'A photo was taken away from its task location, so it was not counted.',
  TOO_FAST: 'A task was completed faster than expected.',
  STEPS_GPS_MISMATCH: 'Movement was recorded without any steps on a walking challenge.',
  CADENCE_IMPLAUSIBLE: 'The step rate was unusually high.',
  PARTICIPANT_WITHDRAWN: 'The participant had left the challenge.',
  CHALLENGE_CANCELLED: 'The challenge was cancelled, so this result is not ranked.',
  GPS_WEAK: 'GPS signal was lost for part of the session.',
  QUEST_DEFINITION_MISMATCH: 'The quest rules on the device did not match.',
  CONFIRM_PENDING: 'A confirmation is waiting for the other player to sync.',
  CONFIRM_UNMATCHED: "A confirmation never arrived from the other player, so it wasn't counted.",
  CONFIRM_SELF: 'A confirmation came from the same person or phone.',
  CONFIRM_SIGNATURE_INVALID: 'A confirmation could not be verified.',
  CONFIRMER_NOT_COPRESENT: "The person who confirmed wasn't at the same place at the same time, so it counts as self-reported.",
  CONFIRM_ROLE_INVALID: 'A confirmation marked as from the organizer came from another player.',
  CONFIRM_RATE: 'One person confirmed an unusually large number of claims today.',
  CONFIRM_RECIPROCAL: 'Two players confirmed each other many times this week.',
  COUNT_IMPLAUSIBLE: 'Some self-reported counts were faster or higher than the activity allows; extra counts were not used.',
  ONLINE_DURING_QUEST: 'The app was online during part of the quest; those minutes were not counted as offline.',
  OFFLINE_UNRECORDED: 'Offline time was not recorded on this phone, so the quest earned no offline credit.',
};

export async function sessionDto(ctx: AppContext, sessionId: string, opts: { viewerId: string; includeMood: boolean }): Promise<SessionDto> {
  const s = await ctx.db.one<any>(
    `SELECT s.*, c.title FROM activity_sessions s JOIN challenges c ON c.id = s.challenge_id WHERE s.id = $1`,
    [sessionId],
  );
  if (!s) throw notFound('Session');
  const score = await ctx.db.one<any>('SELECT * FROM scores WHERE session_id = $1', [sessionId]);
  const run = await ctx.db.one<{ id: string; verdict: string }>('SELECT id, verdict FROM validation_runs WHERE session_id = $1 ORDER BY finished_at DESC LIMIT 1', [sessionId]);
  const flags = run
    ? await ctx.db.query<any>('SELECT code, severity, message FROM session_flags WHERE validation_run_id = $1 ORDER BY created_at', [run.id])
    : [];
  const w = await ctx.db.one<any>('SELECT * FROM session_wellness WHERE session_id = $1', [sessionId]);
  return {
    id: s.id,
    challengeId: s.challenge_id,
    challengeTitle: s.title,
    challengeVersion: s.challenge_version,
    status: s.status,
    verdict: run?.verdict ?? null,
    startedAt: iso(s.started_at_client),
    endedAt: iso(s.ended_at_client),
    score: score
      ? {
          totalPoints: score.total_points,
          completed: score.completed,
          durationS: score.duration_s,
          distanceM: score.distance_m,
          breakdown: score.breakdown,
          status: score.status,
        }
      : null,
    flags: flags.map((f) => ({ code: f.code, severity: f.severity, message: f.message })),
    wellness: w
      ? {
          steps: w.steps,
          avgCadenceSpm: w.avg_cadence_spm,
          activeMinutes: w.active_minutes,
          phoneFreeMinutes: w.phone_free_minutes,
          kcalEstimate: w.kcal_estimate,
          kcalApprox: w.kcal_approx,
          ...(opts.includeMood && s.user_id === opts.viewerId ? { moodBefore: w.mood_before, moodAfter: w.mood_after } : {}),
        }
      : null,
  };
}
