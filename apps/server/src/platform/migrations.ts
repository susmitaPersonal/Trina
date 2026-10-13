/**
 * Forward-only SQL migrations. Runs on PostgreSQL 16 and PGlite.
 * Geo: plain lat/lng columns + engine geo maths (ADR-019); PostGIS can be added later.
 * Docs: docs/data/postgres-schema.md
 */
export const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  share_wellbeing BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE devices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  os_version TEXT,
  public_key TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX devices_user_idx ON devices(user_id);

CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  family_id UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  rotated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens(family_id);

CREATE TABLE idempotency_keys (
  user_id UUID NOT NULL,
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INT NOT NULL,
  response_body JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE challenge_modules (
  id TEXT PRIMARY KEY,
  version INT NOT NULL,
  display_name TEXT NOT NULL,
  params_schema JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE challenge_templates (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  module_ids TEXT[] NOT NULL,
  definition JSONB NOT NULL,
  is_official BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE challenges (
  id UUID PRIMARY KEY,
  creator_id UUID NOT NULL REFERENCES users(id),
  template_id UUID,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','cancelled','archived')),
  visibility TEXT NOT NULL DEFAULT 'public',
  title TEXT NOT NULL,
  current_version INT NOT NULL DEFAULT 1,
  published_version INT,
  start_lng DOUBLE PRECISION NOT NULL,
  start_lat DOUBLE PRECISION NOT NULL,
  opens_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ,
  difficulty TEXT NOT NULL,
  module_ids TEXT[] NOT NULL,
  duration_min INT NOT NULL,
  max_participants INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX challenges_geo_idx ON challenges(start_lat, start_lng);
CREATE INDEX challenges_status_idx ON challenges(status, created_at DESC);

CREATE TABLE challenge_versions (
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  version INT NOT NULL,
  definition JSONB NOT NULL,
  definition_hash TEXT NOT NULL,
  max_score INT NOT NULL,
  engine_min_version INT NOT NULL DEFAULT 1,
  created_by UUID NOT NULL,
  ai_generation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, version)
);

CREATE TABLE challenge_checkpoints (
  challenge_id UUID NOT NULL,
  version INT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  ord INT NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  radius_m DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (challenge_id, version, checkpoint_id)
);

CREATE TABLE teams (
  id UUID PRIMARY KEY,
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (challenge_id, name)
);

CREATE TABLE challenge_participants (
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id UUID REFERENCES teams(id),
  joined_version INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'joined' CHECK (status IN ('joined','withdrawn')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, user_id)
);

CREATE TABLE activity_sessions (
  id UUID PRIMARY KEY,
  challenge_id UUID NOT NULL REFERENCES challenges(id),
  challenge_version INT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL,
  team_id UUID,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','abandoned')),
  started_at_client TIMESTAMPTZ,
  ended_at_client TIMESTAMPTZ,
  first_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_contiguous_seq INT NOT NULL DEFAULT 0,
  final_seq INT,
  chain_head_hash TEXT,
  clock_offset_ms_at_download INT NOT NULL DEFAULT 0,
  validation_status TEXT NOT NULL DEFAULT 'pending',
  track_deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX activity_sessions_user_idx ON activity_sessions(user_id);
CREATE INDEX activity_sessions_challenge_idx ON activity_sessions(challenge_id);

CREATE TABLE activity_events (
  event_id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  type TEXT NOT NULL,
  schema_version INT NOT NULL,
  client_ts TIMESTAMPTZ NOT NULL,
  mono_ms BIGINT NOT NULL,
  payload JSONB NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  batch_id UUID,
  redacted BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (session_id, seq)
);

CREATE TABLE session_tracks (
  session_id UUID PRIMARY KEY REFERENCES activity_sessions(id) ON DELETE CASCADE,
  simplified JSONB NOT NULL,
  distance_m INT NOT NULL,
  duration_s INT NOT NULL
);

CREATE TABLE evidence (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  task_id TEXT NOT NULL,
  checkpoint_id TEXT,
  event_id UUID NOT NULL,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INT NOT NULL,
  width INT,
  height INT,
  captured_at_client TIMESTAMPTZ NOT NULL,
  lng DOUBLE PRECISION,
  lat DOUBLE PRECISION,
  accuracy_m DOUBLE PRECISION,
  storage_key TEXT,
  upload_status TEXT NOT NULL DEFAULT 'pending' CHECK (upload_status IN ('pending','uploaded','verified','rejected')),
  uploaded_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX evidence_session_idx ON evidence(session_id);
CREATE INDEX evidence_sha_idx ON evidence(sha256);

CREATE TABLE sync_batches (
  id UUID PRIMARY KEY,
  device_id UUID NOT NULL,
  user_id UUID NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  events_total INT NOT NULL,
  accepted INT NOT NULL,
  duplicates INT NOT NULL,
  rejected INT NOT NULL
);

CREATE TABLE validation_runs (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,
  engine_version INT NOT NULL,
  pipeline_version INT NOT NULL,
  verdict TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE session_flags (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,
  validation_run_id UUID NOT NULL REFERENCES validation_runs(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warn','critical')),
  message TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  evidence_id UUID,
  resolved_by UUID,
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX session_flags_session_idx ON session_flags(session_id);

CREATE TABLE scores (
  session_id UUID PRIMARY KEY REFERENCES activity_sessions(id) ON DELETE CASCADE,
  challenge_id UUID NOT NULL,
  user_id UUID NOT NULL,
  team_id UUID,
  total_points INT NOT NULL,
  max_score INT NOT NULL,
  breakdown JSONB NOT NULL,
  completed BOOLEAN NOT NULL,
  duration_s INT NOT NULL,
  distance_m INT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('final','hidden','rejected')),
  verdict TEXT NOT NULL,
  engine_version INT NOT NULL,
  inputs_hash TEXT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scores_challenge_idx ON scores(challenge_id);

CREATE TABLE session_wellness (
  session_id UUID PRIMARY KEY REFERENCES activity_sessions(id) ON DELETE CASCADE,
  steps INT,
  avg_cadence_spm INT,
  active_minutes INT NOT NULL,
  phone_free_minutes INT NOT NULL,
  kcal_estimate INT,
  kcal_approx BOOLEAN NOT NULL,
  mood_before SMALLINT,
  mood_after SMALLINT,
  engine_version INT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE leaderboard_entries (
  challenge_id UUID NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('individual','team')),
  subject_id UUID NOT NULL,
  name TEXT NOT NULL,
  rank INT NOT NULL,
  points INT NOT NULL,
  completion_time_s INT,
  verified_level TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, scope, subject_id)
);

CREATE TABLE ai_generations (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  challenge_id UUID,
  kind TEXT NOT NULL DEFAULT 'draft',
  locality TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_text TEXT,
  output_json JSONB,
  valid BOOLEAN NOT NULL,
  repair_attempts INT NOT NULL DEFAULT 0,
  latency_ms INT NOT NULL,
  accepted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY,
  actor_id UUID,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  singleton_key TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts INT NOT NULL DEFAULT 0,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX jobs_singleton_queued_idx ON jobs(singleton_key) WHERE status = 'queued';
CREATE INDEX jobs_ready_idx ON jobs(status, run_after);

CREATE TABLE user_changes (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  kind TEXT NOT NULL,
  ref_id UUID NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX user_changes_user_idx ON user_changes(user_id, id);
`,
  },
  {
    id: 2,
    sql: `
-- Mood check-ins are NOT hash-chained events (privacy); they arrive separately and only on opt-in.
ALTER TABLE activity_sessions ADD COLUMN mood_json JSONB;
`,
  },
  {
    id: 3,
    sql: `
-- Milestones, progression, data modules, signed confirmations, moderation, offline quests, guilds.
-- Design: docs/architecture/milestones-and-custom-modules.md (ADR-023 … ADR-031).

CREATE TABLE module_definitions (
  id TEXT PRIMARY KEY,
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK (origin IN ('official','community')),
  display_name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','suspended','taken_down')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','unlisted','public')),
  current_version INT NOT NULL DEFAULT 1,
  published_version INT,
  forked_from_id TEXT,
  forked_from_version INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX module_definitions_owner_idx ON module_definitions(owner_id, created_at);

CREATE TABLE module_versions (
  module_id TEXT NOT NULL REFERENCES module_definitions(id) ON DELETE CASCADE,
  version INT NOT NULL,
  definition JSONB NOT NULL,
  definition_hash TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  engine_min_version INT NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('ok','note','private_only')),
  risk_report JSONB NOT NULL,
  ai_generation_id UUID,
  created_by UUID NOT NULL,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (module_id, version)
);

CREATE TABLE milestone_definitions (
  module_id TEXT NOT NULL,
  module_version INT NOT NULL,
  milestone_id TEXT NOT NULL,
  window_kind TEXT NOT NULL,
  stat TEXT NOT NULL,
  verification TEXT NOT NULL,
  definition JSONB NOT NULL,
  PRIMARY KEY (module_id, module_version, milestone_id)
);

CREATE TABLE module_reports (
  id UUID PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES module_definitions(id) ON DELETE CASCADE,
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (module_id, reporter_id)
);

CREATE TABLE moderation_cases (
  id UUID PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('module','guild')),
  target_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('auto','report','admin')),
  reason_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  decided_by UUID,
  decision TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX moderation_cases_status_idx ON moderation_cases(status, created_at);

CREATE TABLE session_summaries (
  session_id UUID PRIMARY KEY REFERENCES activity_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  challenge_id UUID NOT NULL,
  day_key DATE NOT NULL,
  week_key TEXT NOT NULL,
  summary JSONB NOT NULL,
  verified BOOLEAN NOT NULL,
  engine_version INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX session_summaries_user_idx ON session_summaries(user_id, day_key);
CREATE INDEX session_summaries_challenge_idx ON session_summaries(challenge_id, day_key);

CREATE TABLE user_milestones (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  milestone_key TEXT NOT NULL,
  window_key TEXT NOT NULL,
  tier TEXT NOT NULL,
  title TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  verification TEXT NOT NULL,
  stat TEXT NOT NULL,
  day_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('final','revoked')),
  source_sessions UUID[] NOT NULL DEFAULT '{}',
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  engine_version INT NOT NULL,
  PRIMARY KEY (user_id, milestone_key, window_key, tier)
);

CREATE TABLE user_progress (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  xp INT NOT NULL DEFAULT 0,
  xp_by_stat JSONB NOT NULL DEFAULT '{}',
  rank_points INT NOT NULL DEFAULT 0,
  rank TEXT NOT NULL DEFAULT 'E',
  verified_outdoor_minutes INT NOT NULL DEFAULT 0,
  offline_quest_minutes INT NOT NULL DEFAULT 0,
  daily_xp JSONB NOT NULL DEFAULT '{}',
  weeks JSONB NOT NULL DEFAULT '{}',
  engine_version INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE peer_confirmations (
  id UUID PRIMARY KEY,
  challenge_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('organizer','peer')),
  issuer_user_id UUID NOT NULL,
  issuer_device_id UUID NOT NULL,
  issuer_session_id UUID,
  issued_claims JSONB,
  issued_sig TEXT,
  issued_at TIMESTAMPTZ,
  subject_user_id UUID NOT NULL,
  subject_session_id UUID NOT NULL,
  received_claims JSONB,
  received_sig TEXT,
  received_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','matched','rejected')),
  reject_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX peer_confirmations_subject_idx ON peer_confirmations(subject_session_id);
CREATE INDEX peer_confirmations_issuer_idx ON peer_confirmations(issuer_user_id, created_at);

-- Offline Quest Mode: one row per device per minute with any authenticated request. No paths, no IPs. 30-day retention.
CREATE TABLE device_request_minutes (
  device_id UUID NOT NULL,
  minute TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (device_id, minute)
);

CREATE TABLE guilds (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT 'leaf',
  leader_id UUID NOT NULL REFERENCES users(id),
  member_limit INT NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','taken_down')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE guild_members (
  guild_id UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('leader','officer','member')),
  share_timeline BOOLEAN NOT NULL DEFAULT true,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX guild_members_user_idx ON guild_members(user_id);

CREATE TABLE guild_invites (
  code TEXT PRIMARY KEY,
  guild_id UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  created_by UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  max_uses INT NOT NULL,
  uses INT NOT NULL DEFAULT 0
);

ALTER TABLE challenges ADD COLUMN guild_id UUID;

-- The well-known Daily Quest challenge (design §5A.2). Quest definitions are rebuilt per session from the
-- SessionStarted template + start fix; this row only anchors sessions (archived: never listed or joinable).
INSERT INTO users (id, email, password_hash, display_name, role) VALUES
  ('0192d41e-0000-7000-8000-00000000c0de', 'system@trina.invalid', '!', 'Trina', 'user') ON CONFLICT DO NOTHING;
INSERT INTO challenges (id, creator_id, status, visibility, title, current_version, published_version, start_lng, start_lat, difficulty, module_ids, duration_min, max_participants)
  VALUES ('0192d41e-0000-7000-8000-000000000001', '0192d41e-0000-7000-8000-00000000c0de', 'archived', 'private', 'Daily Quest', 1, 1, 0, 0, 'easy', '{walking}', 105, 1)
  ON CONFLICT DO NOTHING;
INSERT INTO challenge_versions (challenge_id, version, definition, definition_hash, max_score, engine_min_version, created_by)
  VALUES ('0192d41e-0000-7000-8000-000000000001', 1, '{"kind":"daily-quest-anchor"}', 'daily-quest', 0, 2, '0192d41e-0000-7000-8000-00000000c0de')
  ON CONFLICT DO NOTHING;
`,
  },
  {
    id: 4,
    sql: `
-- Offline Party Mode (ADR-033/034, docs/architecture/offline-party-mode.md). Parties are created by sync
-- from the signed invite in SessionStarted; no coordinates are stored here (the spec is enums only).
CREATE TABLE parties (
  id UUID PRIMARY KEY,
  invite_hash TEXT NOT NULL,
  host_user_id UUID NOT NULL,
  spec JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE party_members (
  session_id UUID PRIMARY KEY,
  party_id UUID NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('host', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX party_members_party_idx ON party_members (party_id);

-- The well-known Party challenge: anchors party sessions like the Daily Quest row (never listed or joinable).
INSERT INTO challenges (id, creator_id, status, visibility, title, current_version, published_version, start_lng, start_lat, difficulty, module_ids, duration_min, max_participants)
  VALUES ('0192d41e-0000-7000-8000-000000000002', '0192d41e-0000-7000-8000-00000000c0de', 'archived', 'private', 'Offline Party', 1, 1, 0, 0, 'easy', '{walking}', 105, 1)
  ON CONFLICT DO NOTHING;
INSERT INTO challenge_versions (challenge_id, version, definition, definition_hash, max_score, engine_min_version, created_by)
  VALUES ('0192d41e-0000-7000-8000-000000000002', 1, '{"kind":"party-anchor"}', 'party', 0, 2, '0192d41e-0000-7000-8000-00000000c0de')
  ON CONFLICT DO NOTHING;
`,
  },
];
