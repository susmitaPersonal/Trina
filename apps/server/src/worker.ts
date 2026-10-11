/**
 * Standalone worker for Postgres deployments (with PGlite the API runs the worker in-process).
 */
import { createContext } from './app';
import { loadConfig } from './config';
import { scheduleMaintenance } from './modules/validation/jobs';

const config = loadConfig();
if (!config.DATABASE_URL) {
  console.error('The standalone worker needs DATABASE_URL (PGlite runs the worker inside the API process).');
  process.exit(1);
}
const ctx = await createContext(config);
ctx.jobs.start(1000);
scheduleMaintenance(ctx);
ctx.logger.info('Trina worker started');
