import { SYNC_PROTOCOL_VERSION, uuidv7, type PullChange } from '@trina/contracts';
import { ApiError, AuthRequiredError, NetworkError, type ApiClient } from './api-client';
import { backoffMs } from './clock';
import type { MilestoneService } from './milestones';
import type { OfflineStore } from './offline-store';
import type { SqlDb } from './sql';

export const PUSH_BATCH_EVENTS = 200;
export const PUSH_BATCH_BYTES = 256 * 1024;

export type SyncReport = {
  outcome: 'ok' | 'offline' | 'auth_required' | 'partial' | 'busy';
  pushed: number;
  duplicates: number;
  rejected: number;
  uploaded: number;
  uploadFailed: number;
  outboxSent: number;
  pulled: number;
  error?: string;
};

export type SyncCounts = {
  pendingEvents: number;
  pendingPhotos: number;
  pendingOutbox: number;
  failed: number;
  waitingForWifi: number;
};

export type SyncWorkerDeps = {
  db: SqlDb;
  api: Pick<ApiClient, 'push' | 'pull' | 'uploadEvidence' | 'request'>;
  store: OfflineStore;
  deviceId: string;
  now?: () => number;
  random?: () => number;
  /** Returns false when photos should wait (e.g. "Wi-Fi only" and on cellular). */
  photosAllowed?: () => boolean;
  /** Milestones: server results replace provisional ones on pull (design §7.3). */
  milestones?: MilestoneService;
  /** Called with module status changes (takedown) so the UI can react. */
  onModuleStatus?: (moduleId: string, status: string) => void;
  /** The signed-in account: only its sessions are pushed/uploaded (another account's data waits on the phone). */
  userId?: () => string | null | undefined;
};

/**
 * Outbox-pattern sync engine. Order per run: push events → upload photos → send outbox → pull.
 * Safe to interrupt at ANY point: state lives in SQLite and every server call is idempotent.
 */
export class SyncWorker {
  private running: Promise<SyncReport> | null = null;
  private recovered = false;

  constructor(private readonly deps: SyncWorkerDeps) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  /** SQL filter + params limiting rows to the signed-in account's sessions (no filter when unknown). */
  private mine(col: string): { sql: string; params: string[] } {
    const u = this.deps.userId?.();
    return u ? { sql: ` AND ${col} IN (SELECT id FROM sessions WHERE user_id = ?)`, params: [u] } : { sql: '', params: [] };
  }

  /** Single-flight: concurrent callers share the same run. */
  runOnce(): Promise<SyncReport> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async counts(): Promise<SyncCounts> {
    const one = async (sql: string, p: (string | number)[] = []) => Number((await this.deps.db.get<{ n: number }>(sql, p))?.n ?? 0);
    const allowed = this.deps.photosAllowed?.() ?? true;
    const ev = this.mine('session_id');
    const photos = await one(`SELECT count(*) AS n FROM evidence WHERE upload_state IN ('pending','uploading')${ev.sql}`, ev.params);
    return {
      pendingEvents: await one(`SELECT count(*) AS n FROM events WHERE sync_state IN ('pending','in_flight')${ev.sql}`, ev.params),
      pendingPhotos: photos,
      pendingOutbox: await one(`SELECT count(*) AS n FROM outbox WHERE state IN ('pending','in_flight')`),
      failed:
        (await one(`SELECT count(*) AS n FROM events WHERE sync_state = 'rejected'`)) +
        (await one(`SELECT count(*) AS n FROM evidence WHERE upload_state = 'failed'`)) +
        (await one(`SELECT count(*) AS n FROM outbox WHERE state = 'rejected'`)),
      waitingForWifi: allowed ? 0 : photos,
    };
  }

  /** Queue a non-event mutation (e.g. join while offline). The row id doubles as Idempotency-Key. */
  async enqueue(kind: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<string> {
    const id = uuidv7(this.now());
    await this.deps.db.run(`INSERT INTO outbox (id, kind, method, path, body_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
      id, kind, method, path, body === undefined ? null : JSON.stringify(body), new Date(this.now()).toISOString(),
    ]);
    return id;
  }

  private async run(): Promise<SyncReport> {
    const r: SyncReport = { outcome: 'ok', pushed: 0, duplicates: 0, rejected: 0, uploaded: 0, uploadFailed: 0, outboxSent: 0, pulled: 0 };
    await this.deps.db.run(`INSERT INTO sync_log (started_at) VALUES (?)`, [new Date(this.now()).toISOString()]);
    if (!this.recovered) {
      // A previous run may have been killed mid-flight: retry those items.
      await this.deps.db.run(`UPDATE events SET sync_state = 'pending' WHERE sync_state = 'in_flight'`);
      await this.deps.db.run(`UPDATE evidence SET upload_state = 'pending' WHERE upload_state = 'uploading'`);
      await this.deps.db.run(`UPDATE outbox SET state = 'pending' WHERE state = 'in_flight'`);
      this.recovered = true;
    }
    try {
      await this.pushEvents(r);
      await this.uploadEvidence(r);
      await this.sendOutbox(r);
      await this.pullChanges(r);
      if (r.uploadFailed > 0 || r.rejected > 0) r.outcome = 'partial';
    } catch (e) {
      if (e instanceof NetworkError) r.outcome = 'offline';
      else if (e instanceof AuthRequiredError) r.outcome = 'auth_required';
      else {
        r.outcome = 'partial';
        r.error = (e as Error).message;
      }
      r.error ??= (e as Error).message;
      // Nothing is lost: un-acked events go back to pending.
      await this.deps.db.run(`UPDATE events SET sync_state = 'pending' WHERE sync_state = 'in_flight'`);
    }
    await this.deps.db.run(`UPDATE sync_log SET finished_at = ?, result_json = ? WHERE id = (SELECT max(id) FROM sync_log)`, [
      new Date(this.now()).toISOString(),
      JSON.stringify(r),
    ]);
    await this.deps.db.run(`DELETE FROM sync_log WHERE id NOT IN (SELECT id FROM sync_log ORDER BY id DESC LIMIT 50)`);
    if (r.outcome !== 'offline' && r.outcome !== 'auth_required') await this.deps.store.setMeta('last_sync_at', new Date(this.now()).toISOString());
    return r;
  }

  private async pushEvents(r: SyncReport) {
    for (let guard = 0; guard < 1000; guard++) {
      // Oldest session first; within a session, contiguous seq order.
      const own = this.mine('session_id');
      const head = await this.deps.db.get<{ session_id: string }>(
        `SELECT session_id FROM events WHERE sync_state = 'pending'${own.sql} ORDER BY rowid LIMIT 1`,
        own.params,
      );
      if (!head) return;
      const rows = await this.deps.db.all<any>(
        `SELECT * FROM events WHERE session_id = ? AND sync_state = 'pending' ORDER BY seq LIMIT ?`,
        [head.session_id, PUSH_BATCH_EVENTS],
      );
      const events: Record<string, unknown>[] = [];
      let bytes = 0;
      for (const e of rows) {
        const ev = {
          eventId: e.event_id, sessionId: e.session_id, seq: Number(e.seq), type: e.type, schemaVersion: Number(e.schema_version),
          clientTs: e.client_ts, monoMs: Number(e.mono_ms), payload: JSON.parse(e.payload_json), prevHash: e.prev_hash, hash: e.hash,
        };
        bytes += e.payload_json.length + 400;
        if (events.length && bytes > PUSH_BATCH_BYTES) break;
        events.push(ev);
      }
      const seqs = events.map((e) => e.seq as number);
      await this.deps.db.run(
        `UPDATE events SET sync_state = 'in_flight' WHERE session_id = ? AND seq BETWEEN ? AND ? AND sync_state = 'pending'`,
        [head.session_id, Math.min(...seqs), Math.max(...seqs)],
      );
      const res = await this.deps.api.push({
        protocolVersion: SYNC_PROTOCOL_VERSION,
        deviceId: this.deps.deviceId,
        batchId: uuidv7(this.now()),
        sessions: [{ sessionId: head.session_id, events }],
      });
      const result = res.results.find((x) => x.sessionId === head.session_id);
      if (!result) throw new Error('Push response missing session result');
      const ackedAt = new Date(this.now()).toISOString();
      await this.deps.db.tx(async (t) => {
        await t.run(`UPDATE events SET sync_state = 'acked', acked_at = ?, last_error = NULL WHERE session_id = ? AND seq <= ? AND sync_state != 'rejected'`, [
          ackedAt, head.session_id, result.ackedThroughSeq,
        ]);
        for (const rej of result.rejected) {
          if (rej.retryable) {
            await t.run(`UPDATE events SET sync_state = 'pending', attempts = attempts + 1, last_error = ? WHERE event_id = ?`, [rej.code, rej.eventId]);
          } else {
            await t.run(`UPDATE events SET sync_state = 'rejected', last_error = ? WHERE event_id = ?`, [`${rej.code}${rej.detail ? `: ${rej.detail}` : ''}`, rej.eventId]);
          }
        }
        await t.run(`UPDATE events SET sync_state = 'pending' WHERE session_id = ? AND sync_state = 'in_flight'`, [head.session_id]);
        for (const id of result.evidenceNeeded) {
          await t.run(`UPDATE evidence SET upload_state = 'pending' WHERE id = ? AND upload_state IN ('uploaded')`, [id]);
        }
      });
      r.pushed += result.accepted;
      r.duplicates += result.duplicates;
      r.rejected += result.rejected.filter((x) => !x.retryable).length;
      // No progress (e.g. waiting for an earlier session's seq 1): stop instead of spinning.
      if (result.accepted === 0 && result.duplicates === 0) {
        const retryable = result.rejected.filter((x) => x.retryable).length;
        if (retryable || result.rejected.length === events.length) return;
      }
    }
  }

  private async uploadEvidence(r: SyncReport) {
    if (this.deps.photosAllowed && !this.deps.photosAllowed()) return;
    // Only upload photos whose EvidenceCaptured event the server already has.
    const own = this.mine('ev.session_id');
    const rows = await this.deps.db.all<any>(
      `SELECT ev.* FROM evidence ev JOIN events e ON e.event_id = ev.event_id
       WHERE ev.upload_state = 'pending' AND ev.next_attempt_at <= ? AND e.sync_state = 'acked'${own.sql} ORDER BY ev.captured_ts LIMIT 50`,
      [this.now(), ...own.params],
    );
    for (const ev of rows) {
      await this.deps.db.run(`UPDATE evidence SET upload_state = 'uploading' WHERE id = ?`, [ev.id]);
      try {
        const out = await this.deps.api.uploadEvidence({ evidenceId: ev.id, fileUri: ev.file_uri, sha256: ev.sha256, sessionId: ev.session_id });
        if (out === 'uploaded') {
          await this.deps.db.run(`UPDATE evidence SET upload_state = 'uploaded', last_error = NULL WHERE id = ?`, [ev.id]);
          r.uploaded++;
        } else {
          await this.deps.db.run(`UPDATE evidence SET upload_state = 'failed', last_error = 'Photo changed after capture' WHERE id = ?`, [ev.id]);
          r.uploadFailed++;
        }
      } catch (e) {
        const attempts = Number(ev.attempts) + 1;
        const permanent = e instanceof ApiError && !e.retryable && e.status !== 404;
        await this.deps.db.run(`UPDATE evidence SET upload_state = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`, [
          permanent ? 'failed' : 'pending', attempts, this.now() + backoffMs(attempts, this.deps.random), (e as Error).message.slice(0, 200), ev.id,
        ]);
        r.uploadFailed++;
        if (e instanceof NetworkError || e instanceof AuthRequiredError) throw e;
      }
    }
  }

  private async sendOutbox(r: SyncReport) {
    const rows = await this.deps.db.all<any>(`SELECT * FROM outbox WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY created_at LIMIT 50`, [this.now()]);
    for (const op of rows) {
      await this.deps.db.run(`UPDATE outbox SET state = 'in_flight' WHERE id = ?`, [op.id]);
      try {
        await this.deps.api.request(op.method, op.path, op.body_json ? JSON.parse(op.body_json) : undefined, { 'Idempotency-Key': op.id });
        await this.deps.db.run(`UPDATE outbox SET state = 'done', last_error = NULL WHERE id = ?`, [op.id]);
        r.outboxSent++;
      } catch (e) {
        const attempts = Number(op.attempts) + 1;
        const permanent = e instanceof ApiError && !e.retryable;
        await this.deps.db.run(`UPDATE outbox SET state = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`, [
          permanent ? 'rejected' : 'pending', attempts, this.now() + backoffMs(attempts, this.deps.random), (e as Error).message.slice(0, 200), op.id,
        ]);
        if (!permanent) throw e;
      }
    }
  }

  private async pullChanges(r: SyncReport) {
    let cursor = (await this.deps.store.getMeta('pull_cursor')) ?? '0';
    for (let guard = 0; guard < 20; guard++) {
      const res = await this.deps.api.pull(cursor);
      for (const c of res.changes) await this.applyChange(c);
      r.pulled += res.changes.length;
      if (res.cursor === cursor || !res.changes.length) break;
      cursor = res.cursor;
      await this.deps.store.setMeta('pull_cursor', cursor);
    }
    // The server is authoritative: replace provisional milestones with its full list (exactly once per row).
    // The "pending" flag is saved before the cursor moves, so a reconcile cut off by the network runs next time.
    if (this.deps.milestones && (await this.deps.store.getMeta('milestones_reconcile_pending')) === '1') {
      const list = await this.deps.api.request<{ items: Parameters<MilestoneService['reconcile']>[0] }>('GET', '/v1/me/milestones?window=all');
      await this.deps.milestones.reconcile(list.items);
      await this.deps.store.setMeta('milestones_reconcile_pending', null);
    }
  }

  private async applyChange(c: PullChange) {
    if (c.kind === 'session_result') {
      await this.deps.db.run(`UPDATE sessions SET verdict = ?, final_score_json = ? WHERE id = ?`, [c.data.verdict, JSON.stringify(c.data), c.data.sessionId]);
      await this.deps.milestones?.markSummaryFinal(c.data.sessionId, c.data.verdict === 'verified' || c.data.verdict === 'verified_with_notes');
    } else if (c.kind === 'challenge_version') {
      await this.deps.store.markStale(c.data.challengeId);
    } else if (c.kind === 'milestones') {
      await this.deps.milestones?.revoke(c.data.revokedKeys ?? []);
      await this.deps.store.setMeta('milestones_reconcile_pending', '1');
    } else if (c.kind === 'progress') {
      await this.deps.milestones?.applyProgress(c.data);
    } else if (c.kind === 'module_status') {
      await this.deps.store.setModuleStatus(c.data.moduleId, c.data.status);
      this.deps.onModuleStatus?.(c.data.moduleId, c.data.status);
    }
  }

  /** Retention: drop acked events of sessions with a final verdict after 7 days (never unacked data). */
  async prune(olderThanMs = 7 * 86_400_000) {
    const cutoff = new Date(this.now() - olderThanMs).toISOString();
    await this.deps.db.run(
      `DELETE FROM events WHERE sync_state = 'acked' AND acked_at < ? AND session_id IN (SELECT id FROM sessions WHERE verdict IS NOT NULL AND status != 'active')`,
      [cutoff],
    );
  }

  async retryFailed() {
    await this.deps.db.run(`UPDATE evidence SET upload_state = 'pending', attempts = 0, next_attempt_at = 0 WHERE upload_state = 'failed'`);
    await this.deps.db.run(`UPDATE outbox SET state = 'pending', next_attempt_at = 0 WHERE state = 'rejected'`);
  }
}
