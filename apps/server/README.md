# apps/server: Trina API and worker

Node + Express 5 + TypeScript modular monolith. Runs on **embedded PGlite** (zero setup) or **PostgreSQL**
(`DATABASE_URL`). Two entrypoints: `src/server.ts` (REST `/v1`, runs jobs in-process by default) and
`src/worker.ts` (standalone jobs for Postgres deployments).

```bash
pnpm dev                 # from repo root: pnpm dev:server
pnpm test                # 22 integration tests (in-memory PGlite)
pnpm typecheck
```

| Module | Responsibility |
|---|---|
| `auth` | register/login (Argon2id), JWT access, rotating refresh with reuse detection, logout |
| `users` | /me, devices, history, wellness totals, account deletion |
| `challenges` | CRUD + immutable versions, publish, discover (nearby), join/teams, offline bundle, leaderboard, impact (JSON/CSV) |
| `sync` | idempotent push ingest (per-event validation, chain watermark), pull feed, session views, opt-in mood, track deletion |
| `evidence` | photo upload (magic bytes, hash binding, sharp re-encode → EXIF stripped), signed URLs |
| `validation` | deterministic pipeline (integrity, temporal, spatial, evidence, behavioral) → flags, verdict, authoritative score, wellness; retention jobs |
| `scoring` | leaderboard rebuild (best attempt, team aggregation) |
| `ai` | self-hosted open-model provider, drafts/variations/patch, recap, explain, model manifest |
| `admin` | flag queue, session review, takedown (audited) |

Docs: [architecture/backend.md](../../docs/architecture/backend.md) · [api-spec](../../docs/api/api-spec.md) · [schema](../../docs/data/postgres-schema.md)

## Rules specific to the server

- Validate every input with zod from `@trina/contracts`; parameterized SQL only; scope every query by owner/participant/admin.
- Sync and evidence endpoints must be idempotent.
- Final scores come **only** from `@trina/engine` in the validation pipeline.
- Never log coordinates, emails or tokens.
