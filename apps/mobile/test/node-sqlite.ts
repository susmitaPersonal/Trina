import { DatabaseSync } from 'node:sqlite';
import { Mutex, type SqlDb, type SqlParam } from '../src/core/sql';

const norm = (p: SqlParam[] = []) => p.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)) as (string | number | null | Uint8Array)[];

/** node:sqlite adapter implementing the same SqlDb interface as expo-sqlite on device. */
export function nodeSqlite(path = ':memory:'): SqlDb & { close(): void } {
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const mutex = new Mutex();
  const make = (inTx: boolean): SqlDb => {
    const db: SqlDb = {
      async run(sql, params) {
        const r = raw.prepare(sql).run(...norm(params));
        return { changes: Number(r.changes) };
      },
      async all<T>(sql: string, params?: SqlParam[]) {
        return raw.prepare(sql).all(...norm(params)) as T[];
      },
      async get<T>(sql: string, params?: SqlParam[]) {
        return (raw.prepare(sql).get(...norm(params)) as T | undefined) ?? null;
      },
      async exec(sql) {
        raw.exec(sql);
      },
      async tx<T>(fn: (d: SqlDb) => Promise<T>) {
        if (inTx) return fn(db);
        return mutex.run(async () => {
          raw.exec('BEGIN IMMEDIATE');
          try {
            const out = await fn(make(true));
            raw.exec('COMMIT');
            return out;
          } catch (e) {
            raw.exec('ROLLBACK');
            throw e;
          }
        });
      },
    };
    return db;
  };
  return Object.assign(make(false), { close: () => raw.close() });
}
