import { uuidv7 } from '@trina/contracts';
import type { Db } from './db';
import type { Logger } from './logger';

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

/**
 * Tiny Postgres-backed job queue (works on PGlite and Postgres; no Redis).
 * `singletonKey` de-duplicates queued jobs (e.g. one validation per session).
 */
export class Jobs {
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private kick: (() => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  register(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
  }

  async enqueue(type: string, payload: Record<string, unknown>, opts: { singletonKey?: string; delayMs?: number } = {}, db: Db = this.db) {
    const runAfter = new Date(Date.now() + (opts.delayMs ?? 0)).toISOString();
    await db.query(
      `INSERT INTO jobs (id, type, payload, singleton_key, run_after) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (singleton_key) WHERE status = 'queued' DO NOTHING`,
      [uuidv7(), type, JSON.stringify(payload), opts.singletonKey ?? null, runAfter],
    );
    this.kick?.();
  }

  /** Processes ready jobs until none are left. Returns how many ran. */
  async drain(max = 100): Promise<number> {
    let n = 0;
    while (n < max) {
      const job = await this.db.tx(async (t) => {
        const j = await t.one<{ id: string; type: string; payload: Record<string, unknown>; attempts: number }>(
          `SELECT id, type, payload, attempts FROM jobs WHERE status = 'queued' AND run_after <= now()
           ORDER BY run_after, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        );
        if (j) await t.query(`UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = now() WHERE id = $1`, [j.id]);
        return j;
      });
      if (!job) break;
      n++;
      const handler = this.handlers.get(job.type);
      try {
        if (!handler) throw new Error(`No handler for job type ${job.type}`);
        await handler(job.payload);
        await this.db.query(`UPDATE jobs SET status = 'done', updated_at = now() WHERE id = $1`, [job.id]);
      } catch (e) {
        const attempts = job.attempts + 1;
        const failed = attempts >= 5;
        this.logger.warn({ jobId: job.id, type: job.type, err: (e as Error).message }, 'job failed');
        await this.db.query(
          `UPDATE jobs SET status = $2, last_error = $3, run_after = now() + ($4 || ' seconds')::interval, updated_at = now() WHERE id = $1`,
          [job.id, failed ? 'failed' : 'queued', (e as Error).message.slice(0, 500), String(2 ** attempts * 5)],
        ).catch(async () => {
          // A queued duplicate may already exist for the singleton key; mark this one failed.
          await this.db.query(`UPDATE jobs SET status = 'failed', last_error = $2 WHERE id = $1`, [job.id, (e as Error).message.slice(0, 500)]);
        });
      }
    }
    return n;
  }

  /** Polls for jobs in the current process. */
  start(intervalMs = 2000) {
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.drain();
      } catch (e) {
        this.logger.error({ err: (e as Error).message }, 'job loop error');
      } finally {
        this.running = false;
      }
    };
    this.kick = () => void setImmediate(tick);
    this.timer = setInterval(tick, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.kick = null;
  }
}
