import type { AppContext } from '../../platform/context';
import { maybeEnqueueValidation } from '../sync/ingest';
import { validateSession } from './pipeline';
import { evaluateUser } from '../progress/service';

export const RAW_GPS_RETENTION_DAYS = 30;
export const EVIDENCE_RETENTION_DAYS = 90;
export const AI_PROMPT_RETENTION_DAYS = 30;
export const STALE_SESSION_HOURS = 48;

/** Registers all background job handlers. */
export function registerJobs(ctx: AppContext) {
  ctx.jobs.register('validate-session', async (p) => {
    await validateSession(ctx, String(p.sessionId));
  });

  // Authoritative milestones + progression for one player (singleton per user).
  ctx.jobs.register('evaluate-milestones', async (p) => {
    await evaluateUser(ctx, String(p.userId));
  });

  ctx.jobs.register('purge-user', async (p) => {
    await ctx.db.query('DELETE FROM users WHERE id = $1 AND deleted_at IS NOT NULL', [String(p.userId)]);
  });

  // Periodic maintenance: retention + stale sessions. Enqueued by `scheduleMaintenance`.
  ctx.jobs.register('maintenance', async () => {
    await runMaintenance(ctx);
  });
}

export async function runMaintenance(ctx: AppContext) {
  // Completed sessions still missing data after 48h: validate anyway (missing evidence gets flagged).
  const stale = await ctx.db.query<{ id: string }>(
    `SELECT id FROM activity_sessions WHERE final_seq IS NOT NULL AND validation_status = 'pending'
     AND last_received_at < now() - ($1 || ' hours')::interval LIMIT 100`,
    [String(STALE_SESSION_HOURS)],
  );
  for (const s of stale) await maybeEnqueueValidation(ctx, s.id, true);

  // Raw GPS: redact LocationBatch payloads after 30 days (simplified track is kept in session_tracks).
  await ctx.db.query(
    `UPDATE activity_events SET payload = '{"samples":[]}'::jsonb, redacted = true
     WHERE type = 'LocationBatch' AND redacted = false AND received_at < now() - ($1 || ' days')::interval`,
    [String(RAW_GPS_RETENTION_DAYS)],
  );

  // Evidence: delete binaries after 90 days.
  const old = await ctx.db.query<{ id: string }>(
    `SELECT id FROM evidence WHERE deleted_at IS NULL AND storage_key IS NOT NULL AND created_at < now() - ($1 || ' days')::interval LIMIT 500`,
    [String(EVIDENCE_RETENTION_DAYS)],
  );
  for (const e of old) {
    await ctx.storage.delete(`evidence/orig/${e.id}`);
    await ctx.storage.delete(`evidence/web/${e.id}.jpg`);
    await ctx.db.query('UPDATE evidence SET deleted_at = now(), storage_key = NULL WHERE id = $1', [e.id]);
  }

  await ctx.db.query(`UPDATE ai_generations SET input_text = NULL WHERE input_text IS NOT NULL AND created_at < now() - ($1 || ' days')::interval`, [
    String(AI_PROMPT_RETENTION_DAYS),
  ]);
  await ctx.db.query('DELETE FROM idempotency_keys WHERE expires_at < now()');
  // Offline-quest request minutes: 30 days. Summaries keep totals; their zone intervals go with raw GPS.
  await ctx.db.query(`DELETE FROM device_request_minutes WHERE minute < now() - ($1 || ' days')::interval`, [String(RAW_GPS_RETENTION_DAYS)]);
  await ctx.db.query(
    `UPDATE session_summaries SET summary = jsonb_set(summary, '{zoneIntervalsMs}', '[]'::jsonb)
     WHERE updated_at < now() - ($1 || ' days')::interval AND jsonb_array_length(summary->'zoneIntervalsMs') > 0`,
    [String(RAW_GPS_RETENTION_DAYS)],
  );
  await ctx.db.query(`DELETE FROM jobs WHERE status = 'done' AND updated_at < now() - interval '7 days'`);
}

export function scheduleMaintenance(ctx: AppContext, everyMs = 10 * 60_000): NodeJS.Timeout {
  const tick = () => void ctx.jobs.enqueue('maintenance', {}, { singletonKey: 'maintenance' }).catch(() => undefined);
  tick();
  return setInterval(tick, everyMs);
}
