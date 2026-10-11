import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { MIGRATIONS } from './migrations';

export type Row = Record<string, unknown>;

/**
 * Minimal database interface over node-postgres (production) or PGlite (zero-setup dev/tests).
 * ALWAYS use parameter placeholders ($1, $2…). Never build SQL from user input.
 */
export interface Db {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T | null>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  kind: 'pg' | 'pglite';
}

function wrapQuery(q: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>) {
  return {
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      return (await q(sql, params)).rows as T[];
    },
    async one<T extends Row>(sql: string, params: unknown[] = []) {
      const rows = (await q(sql, params)).rows as T[];
      return rows[0] ?? null;
    },
  };
}

export async function createPgliteDb(dir: string): Promise<Db> {
  if (dir !== 'memory://') mkdirSync(dir, { recursive: true });
  const lite = dir === 'memory://' ? new PGlite() : new PGlite(dir);
  await lite.waitReady;
  // PGlite is single-connection: serialise transactions explicitly.
  let chain: Promise<unknown> = Promise.resolve();
  const base = wrapQuery((sql, params) => lite.query(sql, params as never[]));
  const db: Db = {
    kind: 'pglite',
    ...base,
    async exec(sql) {
      await lite.exec(sql);
    },
    tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      const run = chain.then(() =>
        lite.transaction(async (t) => {
          const inner: Db = {
            ...db,
            ...wrapQuery((sql, params) => t.query(sql, params as never[])),
            exec: async (sql) => {
              await t.exec(sql);
            },
            tx: (f) => f(inner),
          };
          return fn(inner);
        }),
      );
      chain = run.catch(() => undefined);
      return run as Promise<T>;
    },
    async close() {
      await lite.close();
    },
  };
  return db;
}

export async function createPgDb(url: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const base = wrapQuery((sql, params) => pool.query(sql, params));
  const db: Db = {
    kind: 'pg',
    ...base,
    async exec(sql) {
      await pool.query(sql);
    },
    async tx<T>(fn: (db: Db) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inner: Db = {
          ...db,
          ...wrapQuery((sql, params) => client.query(sql, params)),
          exec: async (sql) => {
            await client.query(sql);
          },
          tx: (f) => f(inner),
        };
        const result = await fn(inner);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
  return db;
}

export async function migrate(db: Db): Promise<number> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ id: number }>('SELECT id FROM schema_migrations')).map((r) => r.id));
  let applied = 0;
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await db.tx(async (t) => {
      await t.exec(m.sql);
      await t.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
    });
    applied++;
  }
  return applied;
}
