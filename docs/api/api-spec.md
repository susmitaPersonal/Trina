# REST API v1

> **Milestones, data modules, quests, confirmations and guilds** are implemented (2026-10-11); design in
> [architecture/milestones-and-custom-modules.md](../architecture/milestones-and-custom-modules.md).

**Status:** implemented in `apps/server` (see tests in `apps/server/test`).

**Conventions**
- Base path `/v1`, JSON (except evidence binary). Auth is `Authorization: Bearer <access>` unless marked *public*.
- Errors use RFC 9457 `application/problem+json`: `{type, title, status, code, detail, errors[]}`.
- Pagination is cursor-based: `?cursor=&limit=` (max 50) → `{items, nextCursor}`.
- POST mutations accept `Idempotency-Key` (UUID). Same key + same body returns the stored response; same key + different body returns `409 IDEMPOTENCY_MISMATCH`.
- All DTOs are zod schemas in `@trina/contracts` (`api/*.ts`). OpenAPI is generated from them.

## Auth

| Method & path | Auth | Request | Response | Notes |
|---|---|---|---|---|
| `POST /auth/register` | public | `{email, password, displayName, ageConfirmed:true, device:{id, platform, appVersion}}` | 201 `{user, accessToken, refreshToken, expiresIn}` | Rate limited; generic error on duplicate email |
| `POST /auth/login` | public | `{email, password, device}` | 200 same | 401 `INVALID_CREDENTIALS` (generic) |
| `POST /auth/refresh` | public | `{refreshToken, deviceId}` | 200 `{accessToken, refreshToken, expiresIn}` | Rotation; reuse returns 401 `TOKEN_REUSED` and revokes the family |
| `POST /auth/logout` | bearer | `{refreshToken}` | 204 | Idempotent |
| `GET /me` | bearer | n/a | `{user, stats}` | n/a |
| `PATCH /me` | bearer | `{displayName?, shareWellbeing?}` | `{user}` | Weight is **not** accepted (device-only) |
| `DELETE /me` | bearer | `{password}` | 202 | Schedules purge |
| `GET /me/devices` | bearer | n/a | `[{id, platform, lastSeenAt, current}]` | n/a |
| `DELETE /me/devices/:id` | bearer | n/a | 204 | Revokes refresh family |
| `GET /me/sessions` | bearer | cursor | history items | n/a |
| `GET /time` | public | n/a | `{serverTime}` | Clock offset |
| `GET /health` | public | n/a | `{ok, version}` | n/a |

## Modules and templates

| Method & path | Response |
|---|---|
| `GET /modules` | `ModuleSummaryDto[]`, see [Data modules](#data-modules-adr-023-adr-028) |
| `GET /templates?module=` | `{items:[{id, title, moduleIds, definition}]}` |

## Challenges

| Method & path | Request | Response | Validation / idempotency |
|---|---|---|---|
| `GET /challenges` | `?near=lat,lng` (client-rounded) `&radiusKm≤50&module=&difficulty=&maxDuration=&cursor=` | `{items:[{id, title, moduleIds, difficulty, durationMin, distanceKm, opensAt, closesAt, participants}], nextCursor}` | Coarse location only |
| `POST /challenges` | `{definition}` or `{templateId, overrides}` + optional `aiGenerationId` | 201 `{id, version:1, status:"draft", validation:{errors[], warnings[]}}` | zod + engine `compile`. **Idempotency-Key required** |
| `GET /challenges/:id` | n/a | `{challenge, currentVersion, definition, myParticipation, stats}` | Drafts visible to the creator only |
| `PATCH /challenges/:id` | `{definition, baseVersion}` | `{version}` | 409 `STALE_VERSION`. Published → creates v+1 |
| `POST /challenges/:id/publish` | `{version}` | `{status:"published"}` | Compile must pass; safety rules |
| `POST /challenges/:id/cancel` | `{reason}` | 200 | Creator or admin |
| `GET /challenges/:id/versions/:v/bundle` | n/a | `{definition, definitionHash, engineMinVersion, mapPack:{url, bbox, bytes, sha256} \| null, ruleText, encouragement[], participants, serverTime}` | Participants only; ETag |
| `POST /challenges/:id/join` | `{teamId?, newTeamName?}` | 200/201 `{participation, joinedVersion}` | Idempotent per user; 409 `CHALLENGE_FULL` / `WINDOW_CLOSED` |
| `POST /challenges/:id/leave` | n/a | 204 | Idempotent |
| `GET /challenges/:id/leaderboard` | `?scope=individual\|team` | `{entries:[{rank, name, points, timeS, verification}], pending:int, updatedAt}` | No locations |

## Sync and sessions

> There is intentionally **no** `POST /sessions`. A session comes into existence on the server
> through its `SessionStarted` event in a sync push, so starting never needs the network.

### `POST /sync/push`

Request (≤ 512 KB):
```json
{
  "protocolVersion": 1,
  "deviceId": "0192…",
  "batchId": "0192…",
  "sessions": [{
    "sessionId": "0192…",
    "events": [{
      "eventId": "0192…", "seq": 41, "type": "LocationBatch", "schemaVersion": 1,
      "clientTs": "2026-10-20T08:14:03.120Z", "monoMs": 2460312,
      "payload": { "samples": [{ "ts": "…", "monoMs": 2459000, "lat": 22.57, "lng": 88.36,
                                 "acc": 8.5, "speed": 1.4, "heading": 92, "alt": 9, "mocked": false }] },
      "prevHash": "ab12…", "hash": "cd34…"
    }]
  }]
}
```

Response 200:
```json
{
  "batchId": "0192…",
  "serverTime": "2026-10-20T09:02:11Z",
  "results": [{
    "sessionId": "0192…",
    "ackedThroughSeq": 57,
    "accepted": 15, "duplicates": 2,
    "rejected": [{ "eventId": "0192…", "code": "SCHEMA_INVALID", "retryable": false }],
    "missingSeqs": [],
    "evidenceNeeded": ["0192…"]
  }]
}
```

### Others

| Method & path | Request | Response | Notes |
|---|---|---|---|
| `GET /sync/pull?cursor=` | n/a | `{changes:[{kind:"score"\|"verdict"\|"challenge_version"\|"participation", id, data}], cursor}` | Only the caller's data |
| `GET /sessions/:id` | n/a | `{session, verdict, flags (user-safe text), score, wellness:{steps, avgCadenceSpm, activeMinutes, phoneFreeMinutes, kcalEstimate, kcalApprox:boolean, moodBefore?, moodAfter?}}` | Owner, creator (limited, **no mood**) or admin |
| `GET /me/wellness` | `?period=week\|month\|all` | `{totals:{sessions, steps, distanceM, activeMinutes, phoneFreeMinutes, kcalEstimate}, moodTrend?:[{date, avgDelta}]}` | Owner only. `moodTrend` only if opted in |
| `GET /challenges/:id/impact` | n/a | `{participants, verifiedSessions, distanceM, steps, kcalEstimate, tasks:{litterBags, treesWatered…}, avgMoodDelta?}` | Creator or admin. Mood only aggregated, with ≥ 5 opted-in participants. SHOULD: `?format=csv` |
| `PUT /sessions/:id/mood` | `{moodBefore?, moodAfter?}` (1–5) | 204 | Owner only; **stored only if the user opted in** (`shareWellbeing`); not hash-chained; never affects score |
| `DELETE /sessions/:id/track` | n/a | 204 | Privacy: redacts raw GPS payloads + simplified track |

## Evidence

| Method & path | Request | Response | Notes |
|---|---|---|---|
| `PUT /evidence/:id/content` | binary; headers `Content-Type`, `X-Content-SHA256`, `X-Session-Id` | 201 `{status:"uploaded"}`; 200 if the same hash exists; 409 `HASH_CONFLICT`; 413; 415/422 | Idempotent; magic bytes; ≤ 5 MB; re-encoded |
| `GET /evidence/:id` | n/a | `{meta, url}` (signed, 5 min) | Authz |

## AI

| Method & path | Request | Response | Notes |
|---|---|---|---|
| `POST /ai/challenge-drafts` | `{prompt (≤1000 chars), mode:"create"\|"variations"\|"patch", baseIntent?, context:{startPoint?, preferredModules?}}` | `{generationId, intents[], definitionDrafts[], validation, provider:{modelId, locality:"self_hosted"}}` | 10/min, 100/day; output always re-validated |
| `POST /ai/explain` | `{challengeId, question}` | `{text, provider, officialRules[]}` | Uses ONLY the deterministic rule text as context; official rules always returned |
| `GET /ai/models` | n/a | `[{id, family, quant, bytes, sha256, url, minRamGb, license}]` | On-device model manifest |
| `POST /ai/recaps` | `{sessionId}` | `{text, provider}` | Server builds the prompt **from stored computed numbers only**; the client can't supply numbers. On device, the same recap is generated locally |
| `POST /ai/generations` | `{modelId, promptVersion, valid, latencyMs, accepted}` | 204 | Opt-in telemetry, no prompt text by default |

## Data modules (ADR-023, ADR-028)

Custom modules are DATA (`ModuleDefinition`, `module/1.0`). The server sets `origin` and `version`; points and
thresholds come from fixed tables; safety is deterministic. MVP visibility: `private` or `unlisted` only.

| Method & path | Auth | Request | Response | Notes |
|---|---|---|---|---|
| `GET /modules` | bearer | n/a | `ModuleSummaryDto[]`: built-in + official (cricket, football) + mine + unlisted ones used by challenges I joined | `Cache-Control: private, max-age=60` |
| `GET /modules/:id/versions/:v` | bearer | n/a | `ModuleVersionDto {id, version, status, visibility, definition, definitionHash, risk, owner, forkedFrom, publishedAt, mine}` | Drafts/private: owner (and admin) only → 404 for others (no IDOR). Taken down → **410 `MODULE_TAKEN_DOWN`** |
| `POST /modules` | bearer | `{definition, aiGenerationId?}` | 201 `{id, version: 1, status: "draft", definition, definitionHash, risk, validation}` | **Idempotency-Key required**. 422 `COMPILE_FAILED` / `MODULE_UNSAFE`; 409 `MODULE_NAME_TAKEN` (official names) / `CONFLICT` (id exists); 429 `QUOTA_EXCEEDED` (5 new per day, 30 kept) |
| `PATCH /modules/:id` | owner | `{definition, baseVersion}` | `{id, version, definition, definitionHash, risk}` | Drafts edited in place; published → v+1. 409 `STALE_VERSION` |
| `POST /modules/:id/publish` | owner | `{version, visibility: "private" \| "unlisted"}` | `{status: "active", visibility}` | `public` → 403 `PUBLIC_NOT_AVAILABLE`; private-only risk + unlisted → 422 `MODULE_UNSAFE` |
| `POST /modules/:id/fork` | bearer | `{fromVersion}` | 201 `{id, version: 1, definition (forkedFrom set)}` | Source must be visible; official modules can be forked; 10/day |
| `POST /modules/:id/report` | bearer | `{reason: unsafe\|offensive\|impersonation\|spam\|other, note?}` | 202 | One per person; 5/day; **3 reports suspend** an active module and open a case |
| `POST /ai/module-drafts` | bearer | `{prompt ≤ 500}` | `ModuleDraftResponse {generationId, status: ok\|refused\|english_only, refusal, intent, definition, issues, risk, notes, usedFallback, provider}` | 10/min and **10/day**. Unsafe prompts are refused before any model runs; English-only input |

Challenges that use a custom module must pin it (`ModuleRef.definitionHash`); creating one with someone else's private
module → 403; publishing needs the module `active` (409 `MODULE_TAKEN_DOWN` otherwise). The challenge **bundle** now
includes `modules[]` (the pinned definitions) and `participantKeys[]` (Ed25519 public keys) for offline play.

## Milestones, progress and Daily Quests (ADR-024, ADR-025, ADR-030)

| Method & path | Auth | Request | Response | Notes |
|---|---|---|---|---|
| `GET /milestones` | bearer | `?moduleId=&version=` | `MilestoneCatalogItemDto[] {key, moduleId, milestoneId, title, description, window, tiers, verification, stat, hidden}` | Generic quests (`*`) + modules; a custom module only if visible to the caller |
| `GET /me/milestones` | owner | `?window=day\|week\|month\|lifetime\|all&date=YYYY-MM-DD` | `{windowKey, items:[{key, windowKey, tier, title, value, verification, label, stat, dayKey, unlockedAt}]}` | Final (server) unlocks only; `label` ∈ Measured / Evidenced / Confirmed / Self-reported |
| `GET /me/progress` | owner | n/a | `ProgressDto {xp, xpByStat, rankPoints, rank, nextRank, verifiedOutdoorMinutes, offlineQuestMinutes, todayXp, dailyXpCap, week:{weekKey, bonus, penalty, forceStopDays, offline90Days}, engineVersion}` | XP/rank never feed challenge score |
| `GET /me/quests` | owner | `?date=` | `DailyQuestDto {dayKey, levelTier, targetMinutes, quests[3]}` | Deterministic per player and day (the phone computes the same list offline) |
| `PUT /me/devices/current/key` | bearer | `{publicKey}` (64 hex) | 204 | Once per install; a different key for the same device → 409 |

**Daily Quest sessions** need no join: `SessionStarted.challengeId` is the well-known `0192d41e-0000-7000-8000-000000000001`
and `payload.quest` names the template; the server rebuilds the definition and checks its hash.

## Guilds (ADR-031, demo cut)

| Method & path | Auth | Request | Response | Notes |
|---|---|---|---|---|
| `GET /me/guilds` | bearer | n/a | `{items:[{id, name, icon, role, members}]}` | |
| `POST /guilds` | bearer | `{name 3–40, description?, icon?}` | 201 `{id, name}` | Names safety-filtered (422); unique (409); 2/day; ≤ 5 guilds per player |
| `GET /guilds/:id` | member | n/a | `GuildDto {members[{displayName, role, rank}], myRole}` | Non-members → 404 |
| `POST /guilds/:id/invites` | leader/officer | `{maxUses ≤ 50}` | 201 `{code (8 chars), expiresAt (7 days)}` | |
| `POST /guilds/join` | bearer | `{code}` | 201/200 `{guildId}` | Idempotent; 410 `INVITE_EXPIRED`; 409 `GUILD_FULL` |
| `POST /guilds/:id/leave` | member | n/a | 204 | Leaders hand over first (409) |
| `GET /guilds/:id/board` | member | `?period=week\|season` | `GuildBoardDto {entries[{displayName, xp, offlineMinutes}], guildQuest{target 600, value}}` | Only members who share their timeline |

## Sync pull: new change kinds

`milestones` `{items: MilestoneProgressDto[], revokedKeys[]}` (final unlocks that changed; the phone then reconciles
with `GET /me/milestones`), `progress` (`ProgressDto`), `module_status` `{moduleId, status}` (suspension/takedown).

## Admin (role = admin)

| Method & path | Purpose |
|---|---|
| `GET /admin/flags?status=open` | Flag queue |
| `GET /admin/sessions/:id` | Timeline, track, evidence (audited) |
| `POST /admin/sessions/:id/review` | `{decision:"approve"\|"reject", note}` |
| `POST /admin/challenges/:id/takedown` | `{reason}` |
| `GET /admin/moderation?status=open\|all` | Module cases (auto: private-only risk; reports) with definition, risk and report count |
| `POST /admin/moderation/:id/decision` | `{decision: dismiss\|suspend\|take_down\|restore, note}`; owners and players get `module_status` on pull; leaderboards rebuilt |
| `POST /admin/modules/:id/takedown` | `{reason}` |

## Error codes (initial)

`VALIDATION_FAILED`, `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `TOKEN_REUSED`, `FORBIDDEN`, `NOT_FOUND`,
`STALE_VERSION`, `CHALLENGE_FULL`, `WINDOW_CLOSED`, `IDEMPOTENCY_MISMATCH`, `HASH_CONFLICT`,
`UNSUPPORTED_MEDIA`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `ENGINE_INCOMPATIBLE`, `AI_UNAVAILABLE`,
`MODULE_UNSAFE`, `MODULE_ID_RESERVED`, `MODULE_TAKEN_DOWN` (409/410), `MODULE_NAME_TAKEN`, `PUBLIC_NOT_AVAILABLE`, `ENGLISH_ONLY`,
`QUOTA_EXCEEDED`, `GUILD_FULL`, `INVITE_EXPIRED`.
