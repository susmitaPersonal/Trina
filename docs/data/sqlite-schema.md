# SQLite schema (device, offline)

> **Migration 2 (2026-10-11)** adds the milestone, module, confirmation and guild-cache tables below.

- `expo-sqlite` with **WAL**, `foreign_keys=ON`. Plain SQL migrations in `apps/mobile/src/core/migrations.ts` (ADR-020), run at app start. Tests run the same SQL on `node:sqlite`.
- JSON stored as TEXT (`*_json`). Booleans as INTEGER 0/1. Times as ISO strings, plus `mono_ms` where relevant.
- **Not in SQLite:** tokens, the device private key and the user's **weight** (secure store; weight never leaves the device); photo, map pack and model binaries (filesystem, referenced by URI).
- Wellness settings (`share_wellbeing`, units) live in `meta`. See [architecture/wellness.md](../architecture/wellness.md).

## Tables

| Table | Columns | Lifetime |
|---|---|---|
| `meta` | key PK, value | Permanent: `schema_version`, `device_id`, `server_clock_offset_ms`, `last_server_time`, `pull_cursor`, `signed_in_user_id`, `milestones_reconcile_pending`, `device_key_registered` |
| `me` | user_id PK, display_name, role, cached_at | Until logout |
| `challenges` | id, version, title, definition_json, definition_hash, status, downloaded_at, offline_ready, map_pack_status, map_pack_uri, bundle_json (rule text, encouragement), clock_offset_ms | PK(id, version). Until window end + 30 days |
| `participations` | challenge_id PK, team_id, joined_version, status | Cache of server state |
| `sessions` | id PK, challenge_id, challenge_version, status (`in_progress`\|`completed`\|`abandoned`), started_wall, boot_id, clock_offset_ms, last_seq, chain_head, provisional_state_json, provisional_score_json, final_score_json, **wellness_json** (steps, cadence, kcal estimate, active and phone-free minutes, mood before/after), steps_baseline, verdict, ended_wall | Kept for history; heavy data pruned |
| `events` | event_id PK, session_id, seq, type, schema_version, client_ts, mono_ms, payload_json, prev_hash, hash, **sync_state** (`pending`\|`in_flight`\|`acked`\|`rejected`), attempts, last_error, acked_at | UNIQUE(session_id, seq). Delete after acked + verdict final + 7 days |
| `location_buffer` | id INTEGER PK, session_id, ts, mono_ms, lat, lng, acc, speed, heading, alt, mocked, flushed_event_id NULL | **Temporary**; deleted once flushed into a `LocationBatch` |
| `evidence` | id PK, session_id, task_id, checkpoint_id, event_id, file_uri, sha256, bytes, captured_ts, lat, lng, acc, upload_state (`pending`\|`uploading`\|`uploaded`\|`verified`\|`failed`), attempts, next_attempt_at, last_error | File deleted after verified + 7 days (optional "Save to my photos") |
| `outbox` | id PK (= Idempotency-Key), kind, method, path, body_json, state (`pending`\|`in_flight`\|`done`\|`rejected`), attempts, next_attempt_at, last_error, created_at | Until done |
| `cache_leaderboards` | challenge_id PK, json, fetched_at | Temporary |
| `ai_models` | id PK, file_uri, sha256, bytes, status | User-managed |
| `ai_drafts` | id PK, prompt, intent_json, definition_json, provider, model_id, created_at | Until published or discarded |
| `sync_log` | id, started_at, finished_at, pushed, uploaded, errors_json | Last 50 rows |

## Milestones, modules, confirmations, quests (migration 2)

| Table | Columns | Lifetime |
|---|---|---|
| `module_defs` | id, version, origin, definition_json, definition_hash, status (`active`\|`suspended`\|`taken_down`), fetched_at | PK(id, version). Custom modules from bundles or my own drafts; takedowns block new sessions |
| `module_drafts` | id PK, prompt, status, definition_json, risk_json, notes_json, provider, generation_id, created_at | Until saved or discarded |
| `session_summaries` | session_id PK, day_key, week_key, summary_json, final, engine_version, updated_at | Permanent (small) |
| `milestone_progress` | milestone_key, window_key, tier, title, value, verification, stat, day_key, status (`provisional`\|`final`\|`revoked`\|`pending_server`), unlocked_at, notified, final_notified, sources_json | PK(milestone_key, window_key, tier): **exactly once**; notification flags |
| `progress` | id = 1, json (`ProgressDto`), updated_at | Server progress cache |
| `confirmations` | id PK, role (`issuer`\|`subject`), session_id, counterpart_user_id, counterpart_name, claims_json, sig, key_checked, state, created_at | Handshake log |
| `cache_guilds` | id PK, json, fetched_at | Last guild board for offline viewing |

`sessions` gains `quest_json` and `quest_definition_json` (offline Daily Quests are built on the phone). The device's
Ed25519 key lives in the secure store, never in SQLite.

## Offline parties (migration 3, ADR-033)

| Table | Columns | Lifetime |
|---|---|---|
| `party_offers` | nonce PK, session_id, created_at, used | Codes this phone showed; an answer must reply to one (anti-replay) |
| `party_answers` | peer_nonce PK, session_id, frames_json, peer_name, created_at | Re-scanning the same offer returns the same answer (no duplicate events) |
| `party_summaries` | party_id, user_id, json (signed `PartySummary`) | PK(party_id, user_id); gossip, derived and provisional, **not** events |

`sessions` gains `party_json` (`{invite, role}`); party definitions are rebuilt from the invite and kept in `quest_definition_json`.

## Indexes

- `events(sync_state, session_id, seq)`: sync worker scan
- `evidence(upload_state, next_attempt_at)`
- `outbox(state, next_attempt_at)`
- `location_buffer(session_id, flushed_event_id)`

## Authority summary

| | PostgreSQL | SQLite |
|---|---|---|
| **Authoritative** | Identity, published challenges, final scores, verdicts, leaderboards | **The raw activity record until the server acks it** (the only copy) |
| **Cached** | n/a | Challenges, participations, leaderboards, profile |
| **Temporary** | Raw samples (30 d), evidence (90 d), idempotency keys (24 h), AI prompts (30 d) | `location_buffer`, acked events, uploaded photos, sync log |

## Write transaction for an event (pseudocode)

```
BEGIN IMMEDIATE
  s = SELECT last_seq, chain_head FROM sessions WHERE id = ?
  e.seq = s.last_seq + 1; e.prevHash = s.chain_head; e.hash = sha256(canonical(e) || e.prevHash)
  INSERT INTO events ...
  UPDATE sessions SET last_seq = e.seq, chain_head = e.hash, provisional_state_json = ? WHERE id = ?
COMMIT
→ only now update UI
```
