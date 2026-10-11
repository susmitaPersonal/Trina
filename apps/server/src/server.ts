import { createApp, createContext } from './app';
import { loadConfig } from './config';
import { scheduleMaintenance } from './modules/validation/jobs';
import { seedIfEmpty } from './seed';

const config = loadConfig();
const ctx = await createContext(config);
await seedIfEmpty(ctx);

if (config.RUN_WORKER_IN_PROCESS) {
  ctx.jobs.start();
  scheduleMaintenance(ctx);
}

const app = createApp(ctx);
const server = app.listen(config.PORT, () => {
  ctx.logger.info(
    { port: config.PORT, db: ctx.db.kind, worker: config.RUN_WORKER_IN_PROCESS, llm: `${ctx.llm.id}` },
    `Trina API listening on http://localhost:${config.PORT}`,
  );
});

const shutdown = async () => {
  ctx.jobs.stop();
  server.close();
  await ctx.db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
