import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { createLlmProvider } from './modules/ai/provider';
import { aiRouter } from './modules/ai/routes';
import { adminRouter } from './modules/admin/routes';
import { authRouter } from './modules/auth/routes';
import { challengesRouter, modulesRouter } from './modules/challenges/routes';
import { evidenceRouter } from './modules/evidence/routes';
import { sessionsRouter, syncRouter } from './modules/sync/routes';
import { usersRouter } from './modules/users/routes';
import { dataModulesRouter, moderationRouter } from './modules/datamodules/routes';
import { guildsRouter } from './modules/guilds/routes';
import { progressRouter } from './modules/progress/routes';
import { registerJobs } from './modules/validation/jobs';
import type { Config } from './config';
import type { AppContext } from './platform/context';
import { createPgDb, createPgliteDb, migrate, type Db } from './platform/db';
import { errorHandler, notFound } from './platform/errors';
import { Jobs } from './platform/jobs';
import { createLogger } from './platform/logger';
import { localStorage } from './platform/storage';
import { ENGINE_VERSION } from '@trina/engine';

export const APP_VERSION = '0.1.0';

export async function createContext(config: Config, overrides: Partial<AppContext> = {}): Promise<AppContext> {
  const logger = overrides.logger ?? createLogger(config.LOG_LEVEL);
  const db: Db = overrides.db ?? (config.DATABASE_URL ? await createPgDb(config.DATABASE_URL) : await createPgliteDb(config.PGLITE_DIR));
  await migrate(db);
  const ctx: AppContext = {
    config,
    db,
    logger,
    storage: overrides.storage ?? localStorage(config.STORAGE_DIR),
    jobs: overrides.jobs ?? new Jobs(db, logger),
    llm: overrides.llm ?? createLlmProvider(config),
    now: overrides.now ?? (() => new Date()),
  };
  registerJobs(ctx);
  return ctx;
}

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use((req, res, next) => {
    const id = req.header('x-request-id') ?? randomUUID();
    res.setHeader('x-request-id', id);
    next();
  });
  // Evidence uploads use their own raw parser; everything else is JSON (sync push ≤ 512 KB).
  app.use((req, res, next) => (req.path.startsWith('/v1/evidence/') ? next() : express.json({ limit: '512kb' })(req, res, next)));

  app.get('/v1/health', (_req, res) => {
    res.json({ ok: true, version: APP_VERSION, engineVersion: ENGINE_VERSION, db: ctx.db.kind });
  });
  app.get('/v1/time', (_req, res) => {
    res.json({ serverTime: ctx.now().toISOString() });
  });

  app.use('/v1/auth', authRouter(ctx));
  app.use('/v1/me', usersRouter(ctx));
  app.use('/v1', modulesRouter(ctx));
  app.use('/v1/challenges', challengesRouter(ctx));
  app.use('/v1/sync', syncRouter(ctx));
  app.use('/v1/sessions', sessionsRouter(ctx));
  app.use('/v1/evidence', evidenceRouter(ctx));
  app.use('/v1/ai', aiRouter(ctx));
  app.use('/v1/admin', adminRouter(ctx));
  app.use('/v1/admin', moderationRouter(ctx));
  app.use('/v1', dataModulesRouter(ctx));
  app.use('/v1', progressRouter(ctx));
  app.use('/v1', guildsRouter(ctx));

  app.use((_req, _res, next) => next(notFound('Route')));
  app.use(errorHandler(ctx.logger));
  return app;
}
