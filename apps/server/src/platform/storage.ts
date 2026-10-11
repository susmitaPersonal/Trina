import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Object storage abstraction. MVP: local filesystem. S3/MinIO driver can implement the same interface. */
export interface Storage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

const SAFE_KEY = /^[a-z0-9/_.-]+$/i;

export function localStorage(rootDir: string): Storage {
  const root = resolve(rootDir);
  const path = (key: string) => {
    if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error('Unsafe storage key');
    return join(root, key);
  };
  return {
    async put(key, data) {
      const p = path(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, data);
    },
    async get(key) {
      try {
        return await readFile(path(key));
      } catch {
        return null;
      }
    },
    async delete(key) {
      await rm(path(key), { force: true });
    },
    async exists(key) {
      try {
        await stat(path(key));
        return true;
      } catch {
        return false;
      }
    },
  };
}
