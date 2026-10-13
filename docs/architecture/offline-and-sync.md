# Offline-first and sync

## 1. Principles

1. Every user action becomes an **immutable event** written in a SQLite transaction (seq and hash
   chain updated atomically) **before** the UI confirms it.
2. Session state is **derived** by folding events through `@trina/engine`. A cache in
   `sessions.provisional_state_json` makes resume fast.
3. **Starting and playing never need the network.** Sessions are created on the device.
4. **Never delete unacknowledged data.** Deletion needs a server ack, a final verdict and a retention period.
5. All server interactions are **idempotent**.

## 2. Event model

| Field | Type | Notes |
|---|---|---|
| `eventId` | UUIDv7 | Client-generated; global idempotency key |
| `sessionId` | UUIDv7 | Challenge, version, user, device and team live on the **session**, not repeated per event |
| `seq` | int | Per session, gapless, starts at 1 |
| `type` | enum | See below |
| `schemaVersion` | int | Payload evolution |
| `clientTs` | ISO string | Wall clock (user-adjustable) |
| `monoMs` | int | Monotonic ms since session start (tamper signal) |
| `payload` | object | zod discriminated union per type |
| `prevHash` | hex | Hash of event `seq-1` (session genesis = hash of session header) |
| `hash` | hex | `SHA-256(canonicalJson(event without hash) ‖ prevHash)` |

`syncState` is **local metadata only**. It sits in a separate SQLite column and is never part of the event.

**Event types (v1):** `SessionStarted`, `LocationBatch`, `GpsSignalLost`, `GpsSignalRestored`,
`CheckpointEntered`, `CheckpointManualConfirm`, `TaskStarted`, `EvidenceCaptured`, `TaskCompleted`,
`TaskUndone`, `BoundaryExited`, `BoundaryEntered`, `SessionPaused`, `SessionResumed`,
`AppBackgrounded`, `AppForegrounded`, `MockLocationDetected`, `ClockAnomalyDetected`,
`SessionCompleted`, `SessionAbandoned`, `OrganizerConfirmation` (deprecated, self-report only),
`StepsSample` (`{cumulative, delta, source}`). See [wellness.md](wellness.md).
**Engine v2 adds:** `CountReported` `{counterId, delta}` (append-only corrections), `ConfirmationIssued` (confirmer's chain,
signed), `ConfirmationReceived` (subject's chain), `ConnectivityChanged` `{online, transport}` and `QuestStopped`
`{kind: force|safety, reason}`; `SessionStarted` gains optional `tzOffsetMin` and `quest`. All additive; the server must be
deployed before apps send them ([milestones-and-custom-modules.md](milestones-and-custom-modules.md)).
**Offline parties add:** `PeerSighting` `{sightingId, kind: join|checkpoint|wrapup, peer: signed SightingToken, myNonce}` and
`SessionStarted.party = {invite, role}`. Additive (no `schemaVersion` bump); party progress summaries are local gossip, not
events ([offline-party-mode.md](offline-party-mode.md)).

**Mood is deliberately not an event.** It doesn't matter for anti-cheat, and keeping it out of the hash
chain means it can stay private. It's stored in `sessions.wellness_json` on the device and included in
`SessionCompleted.payload.wellness.mood` **only if the user opted in** to sharing wellbeing data.

`SessionStarted.payload` includes `{challengeId, challengeVersion, definitionHash, deviceId, teamId,
bootId, clockOffsetMsAtDownload, startFix}`.
`SessionCompleted.payload` includes `{reason: 'rules'|'manual'|'timeout', chainHead, provisionalScore, signature?}`.

**Why `LocationBatch`:** one event per GPS fix is about 3,600 events per hour, which bloats sync and the chain.
Samples go to `location_buffer` and flush as a batch of about 30 samples, or every 60 s.

## 3. Offline bundle

Fetched from `GET /v1/challenges/:id/versions/:v/bundle` at Join or "Prepare".

| Item | Size | Required to start |
|---|---|---|
| Definition (pinned version) + hash | < 50 KB | ✅ |
| `engineMinVersion` | n/a | ✅ (must be ≤ app engine) |
| Map pack (bbox + 500 m, z12–z17) | 5–30 MB | ❌ (compass fallback) |
| Rule text, encouragement lines | < 10 KB | ❌ |
| `serverTime` (for clock offset) | n/a | ✅ |
| Participants/team | small | ✅ |
| Leaderboard snapshot | small | ❌ |

## 4. ONLINE → OFFLINE → ONLINE

1. **Online, before:** join and download the bundle; record `clockOffset = serverTime − deviceTime`;
   rotate the refresh token if it expires in under 7 days; pass pre-flight.
2. **Connectivity lost:** the pill turns amber ("You're offline. Your progress is safe on this device.").
   The sync worker stops and arms a reconnect listener. **Activity Mode behaves the same as online.**
3. **During:** samples go to `location_buffer`, then into `LocationBatch` events. Checkpoints, tasks and evidence are local
   events. Photos are saved in the sandbox with SHA-256. The engine updates the provisional state.
4. **Finish offline:** a `SessionCompleted` event with the chain head. Provisional score shown with "Will verify when online".
5. **Reconnect** (NetInfo, app foreground, or periodic task): the sync worker
   1. refreshes the token (if the refresh token expired, shows "Sign in to sync"; the queue stays, bound to `user_id`)
   2. calls `GET /v1/time` to measure the clock offset again
   3. **pushes events** in `seq` order, batched
   4. **uploads evidence**
   5. sends **outbox** mutations
   6. **pulls** changes
6. **Server:** when the session is complete (completed event, no gaps, all required evidence, or a
   48 h timeout) it runs `validate-session`, producing flags, verdict, final score and leaderboard.
7. **Device:** pull returns the verdict and final score. The pill reads "Everything is synced". Results update and a notification fires.

## 5. Sync channels

| Channel | Data | Endpoint | Ordering | Idempotency |
|---|---|---|---|---|
| Event push | Activity events | `POST /v1/sync/push` | By `(sessionId, seq)` | `eventId` PK |
| Evidence | Photo binaries | `PUT /v1/evidence/:id/content` | After the referencing event (orphans kept 24 h) | `evidenceId` + SHA-256 |
| Outbox | Join, leave, drafts, profile | Regular REST | FIFO per entity | `Idempotency-Key` = outbox row id |
| Pull | Scores, verdicts, challenge versions, participation | `GET /v1/sync/pull?cursor=` | Server cursor | Read-only |

## 6. Push protocol

```mermaid
sequenceDiagram
  participant DB as SQLite
  participant W as SyncWorker
  participant API
  participant PG as Postgres
  participant Q as jobs queue
  W->>DB: select pending events (oldest session, seq asc, ≤200 / 256 KB)
  W->>DB: mark in_flight
  W->>API: POST /v1/sync/push {batchId, sessions[{events}]}
  API->>PG: tx: INSERT ... ON CONFLICT (event_id) DO NOTHING; chain check; update session
  API-->>W: {ackedThroughSeq, duplicates, rejected[], missingSeqs[], evidenceNeeded[]}
  W->>DB: acked / rejected (dead letter)
  loop evidenceNeeded
    W->>API: PUT /v1/evidence/:id/content
  end
  API->>Q: enqueue validate-session when complete
  W->>API: GET /v1/sync/pull?cursor
```

**Server rules per batch** (one transaction):
1. Device belongs to the user; session user is the caller (or the session is new from `SessionStarted`).
2. Validate each event's schema. Bad events are **rejected individually** (`retryable:false`); the batch never fails as a whole.
3. Insert with `ON CONFLICT (event_id) DO NOTHING`. A duplicate id with a **different hash** is rejected and gets a `DUP_ID_DIFF_HASH` flag.
4. Verify `prevHash` where `seq-1` is known. Record gaps. Update `last_contiguous_seq`.
5. Write a `sync_batches` row.
6. After commit, enqueue validation if the session is complete (singleton key = sessionId).

**Lost response:** the server committed but the client timed out. The retry returns `duplicates`, and the client marks them acked. Safe.

## 7. Retry, resume, backoff

- **Backoff:** exponential with full jitter (base 2 s, ×2, cap 15 min). Resets on connectivity change.
- **401:** refresh and retry once. **429 / 5xx / network:** retry. **4xx validation:** dead letter (`rejected`), shown in Sync Status.
- **Triggers:** reconnect, foreground, session completed, every 60 s while foregrounded with pending items, and the background task (Android WorkManager; iOS opportunistic).
- **Resume:** on app start, `in_flight` resets to `pending`. A single-flight mutex allows one sync loop at a time.

## 8. Photos

- Compressed at capture (1600 px long edge, JPEG 0.8, about 300–600 KB). SHA-256 **after** compression goes into
  `EvidenceCaptured`, so it is in the hash chain.
- MVP: single idempotent `PUT` with retry. 200 means the same hash already exists; 409 means a different hash (flagged).
- Wi-Fi-only is an optional setting. Resumable uploads (tus or S3 multipart) are SHOULD.

## 9. Conflict resolution

| Data | Writer | Strategy |
|---|---|---|
| Activity events | Device only, append-only | **No conflicts.** Corrections are new events |
| Challenge definition | Creator via server | Immutable versions. Participants are pinned. Edits create v+1. Participants who haven't started are told to re-download; in-progress sessions keep their version |
| Challenge cancelled while a participant is offline | Server | Session accepted and scored, labelled "cancelled", excluded from leaderboard |
| Join/leave made offline | Outbox | Server wins (e.g. full → "Couldn't join: challenge full") |
| Profile | Either | Last-writer-wins by server receive time |
| Score, verdict | Server only | Device provisional replaced on pull |

## 10. Data lifetime on device

| Data | Deleted when |
|---|---|
| `location_buffer` rows | Flushed into a `LocationBatch` |
| Events | Acked, verdict final, plus 7 days |
| Photos | Verified, plus 7 days (unless the user chose "Save to my photos") |
| Outbox rows | Acked |
| Rejected items | User dismisses them in Sync Status |

## 11. Offline Daily Quests and milestones

- **QuestGuard:** while a Daily Quest runs, `ApiClient` makes no network calls at all (`QuestBlockedError`), the sync worker
  reports `offline`, and connectivity changes become `ConnectivityChanged` events. Own data syncs **before** the quest
  (pre-sync on the start screen) and quest data **after** (when the player turns the internet back on).
- **Milestones on the phone** are evaluated from local session summaries right after a session (offline), stored once per
  (milestone, window, tier) with notification flags. On pull, a `milestones` change makes the phone fetch
  `GET /v1/me/milestones` and **reconcile**: server rows become final; a provisional row the server doesn't list is revoked
  only after every session it came from has a server verdict.

