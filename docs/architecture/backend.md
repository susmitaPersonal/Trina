# Backend architecture (`apps/server`)

A **modular monolith**: one codebase with two entrypoints, `server.ts` (HTTP API) and `worker.ts`
(background jobs).

## Structure

```
apps/server/src
  modules/
    auth/           routes → service → repo
    users/
    challenges/     CRUD, versions, publish, offline bundle
    participation/  join, leave, teams
    sync/           push, pull, batch ack
    evidence/       upload, hash verify, signed URLs
    validation/     pipeline stages, flags, verdict   (runs in worker)
    scoring/        engine adapter, leaderboard materialization
    ai/             provider router, draft endpoint, model manifest
    admin/          flag queue, session review
  platform/         db, config, logger, errors, auth middleware, rate limit, idempotency, storage
  server.ts
  worker.ts
migrations/
```

Each module has `routes.ts` (Express router plus zod validation), `service.ts` (business logic,
no HTTP) and plain parameterized SQL. Integration tests live in `apps/server/test`.

## Choices

| Concern | Choice | Why |
|---|---|---|
| HTTP | Express 5 + TS | As specified; async error handling built in |
| Validation | zod from `@trina/contracts` | One schema source shared with mobile |
| DB | PostgreSQL 16 **or embedded PGlite**; plain parameterized SQL behind `Db` (ADR-019/020) | Zero setup; same SQL everywhere |
| Jobs | `jobs` table queue (`platform/jobs.ts`), singleton keys, backoff (ADR-020) | Works on PGlite and Postgres; no Redis |
| Files | `Storage` interface; local filesystem driver (S3 driver later) | No extra infra |
| Images | `sharp` | Re-encode, strip EXIF, thumbnails |
| Auth | JWT access + opaque rotating refresh; `argon2` | See [security.md](security.md) |
| Errors | RFC 9457 problem+json | Stable `code` values |
| Logging | pino with request ids | No PII or coordinates |
| Rate limit | `express-rate-limit` | Memory store for MVP |
| API docs | `docs/api/api-spec.md` (OpenAPI generation from zod is a TODO) | n/a |
| Tests | Vitest + supertest on in-memory PGlite | No Docker needed |

## Jobs (`jobs` table)

| Job | Trigger | Does |
|---|---|---|
| `validate-session` | Session complete, gapless, evidence uploaded (or 48 h timeout) | Validation pipeline, then score, then leaderboard rebuild |
| `purge-user` | 30 days after account deletion | Hard-delete the user (cascades) |
| `maintenance` | Every 10 min | Validate stale sessions (48 h), redact raw GPS > 30 d (track kept in `session_tracks`), delete evidence > 90 d, null AI prompts > 30 d, expire idempotency keys, prune done jobs |

## Request pipeline

`helmet` → request id → body size limit → auth (JWT) → rate limit → idempotency
(POST mutations) → zod validate → handler → problem+json error mapper.
