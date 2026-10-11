import type { LLMProvider } from '@trina/ai';
import type { Config } from '../config';
import type { Db } from './db';
import type { Jobs } from './jobs';
import type { Logger } from './logger';
import type { Storage } from './storage';

/** Everything a module needs. Passed explicitly (no globals) so tests can swap parts. */
export type AppContext = {
  config: Config;
  db: Db;
  logger: Logger;
  storage: Storage;
  jobs: Jobs;
  /** Self-hosted open-weight model provider (or a fake in tests). */
  llm: LLMProvider;
  now: () => Date;
};

export type AuthUser = { id: string; role: 'user' | 'admin'; deviceId: string };

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}
