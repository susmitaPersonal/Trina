import { ActivityEvent, uuidv7, type PushRequest, type PushSessionResult, type RejectedEvent } from '@trina/contracts';
import { DAILY_QUEST_CHALLENGE_ID } from '@trina/engine';
import type { AppContext } from '../../platform/context';
import type { Db } from '../../platform/db';

type SessionRow = {
  id: string;
  user_id: string;
  challenge_id: string;
  last_contiguous_seq: number;
  final_seq: number | null;
};

async function anomaly(t: Db, sessionId: string, code: string, details: Record<string, unknown>) {
  await t.query(
    `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1, NULL, 'ingest_anomaly', 'session', $2, $3)`,
    [uuidv7(), sessionId, JSON.stringify({ code, ...details })],
  );
}

/**
 * Ingests one push batch. Idempotent: re-sending the same events yields `duplicates`, never double effects.
 * Each event is validated individually; bad events are rejected without failing the batch.
 */
export async function ingestPush(ctx: AppContext, userId: string, body: PushRequest): Promise<PushSessionResult[]> {
  const device = await ctx.db.one<{ user_id: string; revoked_at: string | null }>('SELECT user_id, revoked_at FROM devices WHERE id = $1', [body.deviceId]);
  const deviceOk = !!device && device.user_id === userId && !device.revoked_at;

  const results: PushSessionResult[] = [];
  let total = 0, accepted = 0, duplicates = 0, rejectedN = 0;
  /** Subjects whose confirmations just arrived from the confirmer: re-validate them (claims may now match). */
  const subjectSessions = new Set<string>();

  for (const group of body.sessions) {
    const rejected: RejectedEvent[] = [];
    const valid: ActivityEvent[] = [];
    for (const raw of group.events) {
      total++;
      const eventId = typeof raw.eventId === 'string' ? raw.eventId : 'unknown';
      const parsed = ActivityEvent.safeParse(raw);
      if (!parsed.success) {
        rejected.push({ eventId, code: 'SCHEMA_INVALID', retryable: false, detail: parsed.error.issues[0]?.message });
        continue;
      }
      if (parsed.data.sessionId !== group.sessionId) {
        rejected.push({ eventId, code: 'SESSION_MISMATCH', retryable: false });
        continue;
      }
      valid.push(parsed.data);
    }
    valid.sort((a, b) => a.seq - b.seq);

    const r = await ctx.db.tx(async (t) => {
      let acc = 0, dup = 0;
      let session = await t.one<SessionRow>('SELECT id, user_id, challenge_id, last_contiguous_seq, final_seq FROM activity_sessions WHERE id = $1 FOR UPDATE', [group.sessionId]);

      if (!session) {
        const start = valid.find((e) => e.type === 'SessionStarted');
        if (!start || start.type !== 'SessionStarted' || start.seq !== 1) {
          for (const e of valid) rejected.push({ eventId: e.eventId, code: 'SESSION_UNKNOWN', retryable: true, detail: 'Send SessionStarted (seq 1) first' });
          return null;
        }
        const p = start.payload;
        const fail = (code: string, detail: string) => {
          for (const e of valid) rejected.push({ eventId: e.eventId, code, retryable: false, detail });
          return null;
        };
        if (!deviceOk || p.deviceId !== body.deviceId) return fail('DEVICE_INVALID', 'Device not registered to this user');
        if (p.userId !== userId) return fail('FORBIDDEN', 'Session belongs to another user');
        // Offline Daily Quests need no join: the definition is rebuilt from the template (design §5A.2).
        const isQuest = p.challengeId === DAILY_QUEST_CHALLENGE_ID;
        if (isQuest && !p.quest) return fail('SCHEMA_INVALID', 'Daily Quest sessions need a quest template');
        const version = await t.one<{ definition_hash: string }>('SELECT definition_hash FROM challenge_versions WHERE challenge_id = $1 AND version = $2', [p.challengeId, isQuest ? 1 : p.challengeVersion]);
        if (!version) return fail('CHALLENGE_UNKNOWN', 'Unknown challenge version');
        const part = isQuest
          ? { team_id: null, status: 'joined' }
          : await t.one<{ team_id: string | null; status: string }>('SELECT team_id, status FROM challenge_participants WHERE challenge_id = $1 AND user_id = $2', [p.challengeId, userId]);
        if (!part) return fail('NOT_PARTICIPANT', 'Join the challenge first');
        await t.query(
          `INSERT INTO activity_sessions (id, challenge_id, challenge_version, user_id, device_id, team_id, started_at_client, clock_offset_ms_at_download)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [group.sessionId, p.challengeId, isQuest ? 1 : p.challengeVersion, userId, body.deviceId, part.team_id, start.clientTs, p.clockOffsetMsAtDownload],
        );
        if (part.status !== 'joined') await anomaly(t, group.sessionId, 'PARTICIPANT_WITHDRAWN', {});
        session = { id: group.sessionId, user_id: userId, challenge_id: p.challengeId, last_contiguous_seq: 0, final_seq: null };
      } else if (session.user_id !== userId) {
        for (const e of valid) rejected.push({ eventId: e.eventId, code: 'FORBIDDEN', retryable: false });
        return null;
      }

      for (const e of valid) {
        const byId = await t.one<{ hash: string; session_id: string }>('SELECT hash, session_id FROM activity_events WHERE event_id = $1', [e.eventId]);
        if (byId) {
          if (byId.hash === e.hash && byId.session_id === e.sessionId) dup++;
          else {
            rejected.push({ eventId: e.eventId, code: 'DUP_ID_DIFF_HASH', retryable: false });
            await anomaly(t, session.id, 'DUP_ID_DIFF_HASH', { eventId: e.eventId, seq: e.seq });
          }
          continue;
        }
        const bySeq = await t.one<{ event_id: string }>('SELECT event_id FROM activity_events WHERE session_id = $1 AND seq = $2', [e.sessionId, e.seq]);
        if (bySeq) {
          rejected.push({ eventId: e.eventId, code: 'SEQ_CONFLICT', retryable: false });
          await anomaly(t, session.id, 'SEQ_CONFLICT', { eventId: e.eventId, seq: e.seq });
          continue;
        }
        await t.query(
          `INSERT INTO activity_events (event_id, session_id, seq, type, schema_version, client_ts, mono_ms, payload, prev_hash, hash, batch_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [e.eventId, e.sessionId, e.seq, e.type, e.schemaVersion, e.clientTs, e.monoMs, JSON.stringify(e.payload), e.prevHash, e.hash, body.batchId],
        );
        acc++;
        if (e.type === 'EvidenceCaptured') {
          const p = e.payload;
          const ins = await t.query(
            `INSERT INTO evidence (id, session_id, user_id, task_id, checkpoint_id, event_id, sha256, mime, bytes, captured_at_client, lng, lat, accuracy_m)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (id) DO NOTHING RETURNING id`,
            [p.evidenceId, e.sessionId, userId, p.taskId, p.checkpointId, e.eventId, p.sha256, p.mime, p.bytes, e.clientTs, p.fix?.lng ?? null, p.fix?.lat ?? null, p.fix?.acc ?? null],
          );
          if (!ins.length) await anomaly(t, session.id, 'EVIDENCE_ID_REUSED', { evidenceId: p.evidenceId });
        }
        if (e.type === 'ConfirmationIssued') {
          // Confirmer side (signed with the confirmer's device key). Stored; trusted only after the pipeline checks.
          const p = e.payload;
          await t.query(
            `INSERT INTO peer_confirmations (id, challenge_id, role, issuer_user_id, issuer_device_id, issuer_session_id, issued_claims, issued_sig, issued_at, subject_user_id, subject_session_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (id) DO UPDATE SET issuer_session_id = EXCLUDED.issuer_session_id, issued_claims = EXCLUDED.issued_claims, issued_sig = EXCLUDED.issued_sig, issued_at = EXCLUDED.issued_at
             WHERE peer_confirmations.issuer_user_id = EXCLUDED.issuer_user_id AND peer_confirmations.issued_sig IS NULL`,
            [p.confirmationId, p.challengeId, p.role, userId, body.deviceId, e.sessionId, JSON.stringify(p.claims), p.sig, e.clientTs, p.subjectUserId, p.subjectSessionId],
          );
          subjectSessions.add(p.subjectSessionId);
        }
        if (e.type === 'ConfirmationReceived') {
          const p = e.payload;
          await t.query(
            `INSERT INTO peer_confirmations (id, challenge_id, role, issuer_user_id, issuer_device_id, subject_user_id, subject_session_id, received_claims, received_sig, received_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (id) DO UPDATE SET received_claims = EXCLUDED.received_claims, received_sig = EXCLUDED.received_sig, received_at = EXCLUDED.received_at
             WHERE peer_confirmations.subject_user_id = EXCLUDED.subject_user_id AND peer_confirmations.received_sig IS NULL`,
            [p.confirmationId, session.challenge_id, p.role, p.issuerUserId, p.issuerDeviceId, userId, e.sessionId, JSON.stringify(p.claims), p.sig, e.clientTs],
          );
        }
        if (e.type === 'SessionCompleted' || e.type === 'SessionAbandoned') {
          await t.query(
            `UPDATE activity_sessions SET final_seq = $2, status = $3, ended_at_client = $4 WHERE id = $1 AND final_seq IS NULL`,
            [e.sessionId, e.seq, e.type === 'SessionCompleted' ? 'completed' : 'abandoned', e.clientTs],
          );
        }
      }

      // Advance the contiguous watermark and chain head.
      const seqs = await t.query<{ seq: number; hash: string }>(
        'SELECT seq, hash FROM activity_events WHERE session_id = $1 AND seq > $2 ORDER BY seq',
        [session.id, session.last_contiguous_seq],
      );
      let contiguous = session.last_contiguous_seq;
      let head: string | null = null;
      for (const s of seqs) {
        if (s.seq !== contiguous + 1) break;
        contiguous = s.seq;
        head = s.hash;
      }
      const maxSeq = seqs.length ? seqs[seqs.length - 1]!.seq : contiguous;
      const received = new Set(seqs.map((s) => s.seq));
      const missing: number[] = [];
      for (let i = contiguous + 1; i < maxSeq && missing.length < 50; i++) if (!received.has(i)) missing.push(i);
      await t.query(
        `UPDATE activity_sessions SET last_contiguous_seq = $2, chain_head_hash = COALESCE($3, chain_head_hash), last_received_at = now() WHERE id = $1`,
        [session.id, contiguous, head],
      );
      const pending = await t.query<{ id: string }>(`SELECT id FROM evidence WHERE session_id = $1 AND upload_status = 'pending' ORDER BY created_at`, [session.id]);
      return { acc, dup, contiguous, missing, evidenceNeeded: pending.map((p) => p.id) };
    });

    accepted += r?.acc ?? 0;
    duplicates += r?.dup ?? 0;
    rejectedN += rejected.length;
    results.push({
      sessionId: group.sessionId,
      ackedThroughSeq: r?.contiguous ?? 0,
      accepted: r?.acc ?? 0,
      duplicates: r?.dup ?? 0,
      rejected,
      missingSeqs: r?.missing ?? [],
      evidenceNeeded: r?.evidenceNeeded ?? [],
    });
    if (r) await maybeEnqueueValidation(ctx, group.sessionId);
  }

  await ctx.db.query(
    `INSERT INTO sync_batches (id, device_id, user_id, events_total, accepted, duplicates, rejected) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET accepted = sync_batches.accepted + EXCLUDED.accepted, duplicates = sync_batches.duplicates + EXCLUDED.duplicates`,
    [body.batchId, body.deviceId, userId, total, accepted, duplicates, rejectedN],
  );
  if (deviceOk) await ctx.db.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [body.deviceId]);
  for (const sid of subjectSessions) {
    const st = await ctx.db.one<{ validation_status: string }>('SELECT validation_status FROM activity_sessions WHERE id = $1', [sid]);
    if (st && st.validation_status !== 'pending') await maybeEnqueueValidation(ctx, sid);
  }
  return results;
}

/** A session is ready to validate once it is complete, gap-free and all evidence is uploaded. */
export async function maybeEnqueueValidation(ctx: AppContext, sessionId: string, force = false) {
  const s = await ctx.db.one<{ final_seq: number | null; last_contiguous_seq: number; validation_status: string }>(
    'SELECT final_seq, last_contiguous_seq, validation_status FROM activity_sessions WHERE id = $1',
    [sessionId],
  );
  if (!s || s.final_seq === null) return false;
  if (!force) {
    if (s.last_contiguous_seq < s.final_seq) return false;
    const pending = await ctx.db.one(`SELECT 1 FROM evidence WHERE session_id = $1 AND upload_status = 'pending' LIMIT 1`, [sessionId]);
    if (pending) return false;
  }
  await ctx.jobs.enqueue('validate-session', { sessionId }, { singletonKey: `validate:${sessionId}` });
  return true;
}
