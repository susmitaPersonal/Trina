/**
 * Minimal async SQLite interface. Implemented by expo-sqlite on device and node:sqlite in tests,
 * so all offline logic (event log, outbox, sync) is testable without a phone.
 */
export type SqlParam = string | number | null | boolean | Uint8Array;

export interface SqlDb {
  run(sql: string, params?: SqlParam[]): Promise<{ changes: number }>;
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | null>;
  exec(sql: string): Promise<void>;
  /** Exclusive transaction. Nested calls reuse the outer transaction. */
  tx<T>(fn: (db: SqlDb) => Promise<T>): Promise<T>;
}

export const bool = (v: unknown): boolean => v === 1 || v === true || v === '1';
export const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

/** Serialises async work (used to make transactions exclusive in adapters without native support). */
export class Mutex {
  private last: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.last.then(fn, fn);
    this.last = next.catch(() => undefined);
    return next;
  }
}
