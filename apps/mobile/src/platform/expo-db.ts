import * as SQLite from 'expo-sqlite';
import type { SqlDb, SqlParam } from '../core/sql';

const norm = (p: SqlParam[] = []) => p.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)) as SQLite.SQLiteBindValue[];

type Executor = Pick<SQLite.SQLiteDatabase, 'runAsync' | 'getAllAsync' | 'getFirstAsync' | 'execAsync'>;

function wrap(exec: Executor, txRunner: SqlDb['tx'] | null): SqlDb {
  const db: SqlDb = {
    async run(sql, params) {
      const r = await exec.runAsync(sql, norm(params));
      return { changes: r.changes };
    },
    all: <T,>(sql: string, params?: SqlParam[]) => exec.getAllAsync<T>(sql, norm(params)),
    get: <T,>(sql: string, params?: SqlParam[]) => exec.getFirstAsync<T>(sql, norm(params)),
    exec: (sql) => exec.execAsync(sql),
    tx: txRunner ?? ((fn) => fn(db)),
  };
  return db;
}

let opened: Promise<SqlDb> | null = null;

/** Opens the on-device database once (WAL). Shared by the UI and the background location task. */
export function openDeviceDb(): Promise<SqlDb> {
  opened ??= (async () => {
    const raw = await SQLite.openDatabaseAsync('trina.db');
    await raw.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const tx: SqlDb['tx'] = async (fn) => {
      let out: unknown;
      await raw.withExclusiveTransactionAsync(async (txn) => {
        out = await fn(wrap(txn, null));
      });
      return out as never;
    };
    return wrap(raw, tx);
  })();
  return opened;
}
