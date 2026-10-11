import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  /** Real Postgres (production). When absent, an embedded PGlite database is used. */
  DATABASE_URL: z.string().optional(),
  /** PGlite data dir; 'memory://' for in-memory. */
  PGLITE_DIR: z.string().default('./.data/pglite'),
  JWT_SECRET: z.string().min(32).optional(),
  ACCESS_TOKEN_TTL_S: z.coerce.number().int().default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  STORAGE_DIR: z.string().default('./.data/evidence'),
  /** Run the job worker inside the API process (required with PGlite). */
  RUN_WORKER_IN_PROCESS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** OpenAI-compatible endpoint of a SELF-HOSTED open-weight model (Ollama, llama.cpp server, vLLM). */
  LLM_BASE_URL: z.string().default('http://localhost:11434/v1'),
  LLM_MODEL: z.string().default('qwen3:4b'),
  LLM_TIMEOUT_MS: z.coerce.number().int().default(60_000),
  /** Optional PMTiles URL for offline map packs. */
  TILES_URL: z.string().optional(),
  RATE_LIMITS: z
    .enum(['on', 'off'])
    .default('on')
    .transform((v) => v === 'on'),
  ARGON2_MEMORY_KIB: z.coerce.number().int().default(19_456),
  ARGON2_TIME_COST: z.coerce.number().int().default(2),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
});

export type Config = z.infer<typeof Env> & { JWT_SECRET: string };

const DEV_SECRET = 'dev-only-insecure-secret-change-me-0123456789abcdef';

export function loadConfig(overrides: Partial<Record<keyof z.input<typeof Env>, string>> = {}): Config {
  const parsed = Env.parse({ ...process.env, ...overrides });
  if (!parsed.JWT_SECRET && parsed.NODE_ENV === 'production') throw new Error('JWT_SECRET is required in production');
  return { ...parsed, JWT_SECRET: parsed.JWT_SECRET ?? DEV_SECRET };
}

export function testConfig(overrides: Partial<Record<string, string>> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    PGLITE_DIR: 'memory://',
    STORAGE_DIR: `./.data/test-evidence-${process.pid}-${Date.now()}`,
    RATE_LIMITS: 'off',
    ARGON2_MEMORY_KIB: '1024',
    ARGON2_TIME_COST: '1',
    LOG_LEVEL: 'silent',
    LLM_BASE_URL: 'http://127.0.0.1:9/v1',
    LLM_TIMEOUT_MS: '500',
    ...overrides,
  });
}
