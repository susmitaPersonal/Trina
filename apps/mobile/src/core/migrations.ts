import type { SqlDb } from './sql';

/** Local schema (docs/data/sqlite-schema.md). Forward-only. */
const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS me (
  user_id TEXT PRIMARY KEY, email TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL,
  share_wellbeing INTEGER NOT NULL DEFAULT 0, cached_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT NOT NULL, version INTEGER NOT NULL, title TEXT NOT NULL,
  definition_json TEXT NOT NULL, definition_hash TEXT NOT NULL, max_score INTEGER NOT NULL,
  engine_min_version INTEGER NOT NULL, bundle_json TEXT NOT NULL, team_id TEXT,
  clock_offset_ms INTEGER NOT NULL DEFAULT 0, downloaded_at TEXT NOT NULL, offline_ready INTEGER NOT NULL DEFAULT 1,
  stale INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL, challenge_version INTEGER NOT NULL, user_id TEXT NOT NULL,
  status TEXT NOT NULL, started_wall TEXT NOT NULL, ended_wall TEXT, boot_id TEXT NOT NULL,
  clock_offset_ms INTEGER NOT NULL DEFAULT 0, last_seq INTEGER NOT NULL DEFAULT 0, chain_head TEXT NOT NULL,
  last_mono INTEGER NOT NULL DEFAULT 0, last_wall_ms INTEGER NOT NULL DEFAULT 0,
  provisional_score_json TEXT, final_score_json TEXT, wellness_json TEXT, verdict TEXT,
  steps_baseline INTEGER, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL,
  schema_version INTEGER NOT NULL, client_ts TEXT NOT NULL, mono_ms INTEGER NOT NULL, payload_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
  sync_state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, acked_at TEXT,
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS events_sync_idx ON events(sync_state, session_id, seq);

CREATE TABLE IF NOT EXISTS location_buffer (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts TEXT NOT NULL, mono_ms INTEGER NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL, acc REAL NOT NULL, speed REAL, heading REAL, alt REAL, mocked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS location_buffer_session_idx ON location_buffer(session_id, id);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL, checkpoint_id TEXT, event_id TEXT NOT NULL,
  file_uri TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, captured_ts TEXT NOT NULL,
  lat REAL, lng REAL, acc REAL,
  upload_state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS evidence_upload_idx ON evidence(upload_state, next_attempt_at);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, body_json TEXT,
  state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cache_leaderboards (challenge_id TEXT NOT NULL, scope TEXT NOT NULL, json TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY (challenge_id, scope));

CREATE TABLE IF NOT EXISTS ai_models (id TEXT PRIMARY KEY, file_uri TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, status TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS ai_drafts (
  id TEXT PRIMARY KEY, prompt TEXT NOT NULL, intent_json TEXT NOT NULL, definition_json TEXT, provider TEXT NOT NULL,
  model_id TEXT NOT NULL, generation_id TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT, result_json TEXT);
`,
  },
  {
    id: 2,
    sql: `
-- Milestones, progression, custom data modules, confirmations, offline quests, guild caches (docs/data/sqlite-schema.md).
CREATE TABLE IF NOT EXISTS module_defs (
  id TEXT NOT NULL, version INTEGER NOT NULL, origin TEXT NOT NULL, definition_json TEXT NOT NULL, definition_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', fetched_at TEXT NOT NULL, PRIMARY KEY (id, version)
);
CREATE TABLE IF NOT EXISTS module_drafts (
  id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, definition_json TEXT, risk_json TEXT NOT NULL, notes_json TEXT NOT NULL,
  provider TEXT NOT NULL, generation_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_summaries (
  session_id TEXT PRIMARY KEY, day_key TEXT NOT NULL, week_key TEXT NOT NULL, summary_json TEXT NOT NULL,
  final INTEGER NOT NULL DEFAULT 0, engine_version INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS session_summaries_day_idx ON session_summaries(day_key);
CREATE TABLE IF NOT EXISTS milestone_progress (
  milestone_key TEXT NOT NULL, window_key TEXT NOT NULL, tier TEXT NOT NULL, title TEXT NOT NULL, value REAL NOT NULL,
  verification TEXT NOT NULL, stat TEXT NOT NULL, day_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('provisional','final','revoked','pending_server')),
  unlocked_at TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0, final_notified INTEGER NOT NULL DEFAULT 0, sources_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (milestone_key, window_key, tier)
);
CREATE TABLE IF NOT EXISTS progress (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS confirmations (
  id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('issuer','subject')), session_id TEXT NOT NULL, counterpart_user_id TEXT NOT NULL,
  counterpart_name TEXT NOT NULL DEFAULT '', claims_json TEXT NOT NULL, sig TEXT NOT NULL, key_checked INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'issued', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cache_guilds (id TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at TEXT NOT NULL);
ALTER TABLE sessions ADD COLUMN quest_json TEXT;
ALTER TABLE sessions ADD COLUMN quest_definition_json TEXT;
`,
  },
];

export async function migrateLocal(db: SqlDb): Promise<void> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY)');
  const done = new Set((await db.all<{ id: number }>('SELECT id FROM schema_migrations')).map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await db.tx(async (t) => {
      await t.exec(m.sql);
      await t.run('INSERT INTO schema_migrations (id) VALUES (?)', [m.id]);
    });
  }
}
