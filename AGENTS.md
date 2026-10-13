# AGENTS.md — Trina (তৃণ)

> Universal entry point for **any** AI agent, coding assistant, or new human contributor
> (Claude Code, Cursor, Copilot, Codex, Bolt, Windsurf, sub-agents, skills…).
> Read this file first. It is short on purpose and links to everything else.

---

## 1. What this project is (30-second version)

**Trina** (তৃণ, Bengali for "grass") is an offline-first mobile platform for real-world outdoor challenges
(walking, cycling, running, litter clean-ups, tree watering, scavenger hunts, …).
Built for **Hacktoberfest 2026 — "Touch Grass"** theme.

- Users **create** challenges (optionally with a **local open-weight AI** "Challenge Agent"),
  **join**, **download for offline**, **go outside**, complete tasks with **GPS + photo evidence**,
  and **auto-sync** when back online. The **server validates** and updates a **leaderboard**.
- Design motto: **"Use the phone for two minutes, spend sixty outside."**

## 2. Monorepo layout

```
apps/mobile        React Native (Expo dev build) + TypeScript + SQLite   → apps/mobile/README.md
apps/server        Node + Express + TypeScript + PostgreSQL/PostGIS      → apps/server/README.md
packages/contracts zod schemas: Challenge DSL, events, sync, API DTOs     → packages/contracts/README.md
packages/engine    Pure deterministic rules/scoring engine + modules      → packages/engine/README.md
packages/ai        LLM provider abstraction, prompts, intent compiler     → packages/ai/README.md
infra/             docker-compose (postgres+postgis, minio, ollama)       → infra/README.md
docs/              All design docs                                        → docs/README.md
```

Package manager: **pnpm workspaces**. Language: **TypeScript everywhere**.

## 3. Where am I? (state of the project)

👉 **Always check [`docs/STATUS.md`](docs/STATUS.md) first** — it says what is built, what is in
progress, and what is next. Update it when you finish meaningful work.

## 4. Non-negotiable rules (do not violate without a new ADR)

1. **The LLM is never a source of truth.** It must not decide GPS validity, timestamps,
   scores, completion, leaderboard, auth, or anti-cheat. AI output only enters the system via
   `ChallengeIntent → deterministic compiler → validator → human publishes`.
2. **The LLM never outputs coordinates.** Locations come from the user (map pins) or
   deterministic geo code.
3. **Scoring lives only in `packages/engine`.** Pure functions: no `Date.now()`, no randomness,
   no I/O. Same engine runs on device (provisional) and server (authoritative).
4. **Activity events are append-only and immutable.** Corrections are new events.
   Each event has a client UUIDv7 `eventId`, per-session gapless `seq`, `prevHash`/`hash`.
5. **SQLite is the source of truth on the device** until the server acknowledges. Never delete
   unacknowledged data. Write to SQLite *before* showing UI success.
6. **Starting/playing a challenge must never require network.** Sessions are created on the
   device; the server learns about them via sync.
7. **All sync and mutation endpoints are idempotent** (event IDs, evidence IDs + SHA-256,
   `Idempotency-Key` header).
8. **Schemas are defined once** in `packages/contracts` (zod) and imported by mobile + server.
9. **Privacy:** never record location before a session starts; never log coordinates or PII;
   respect retention (raw GPS 30 days, photos 90 days).
10. **No proprietary cloud LLMs.** Only open-weight models via the `LLMProvider` interface.
11. **Flag, don't accuse.** Anti-cheat produces flags + verdicts; never claim certainty.
12. **Parameterized SQL only.** Validate every input with zod.
13. **Wellness is measured, not generated.** Steps come from the pedometer sensor and calories from
    the engine's MET formula; mood is the user's own check-in. The AI may only *phrase* a recap from
    those numbers. Wellness never affects score. Weight is device-only; mood is shared only on opt-in.

**In one line:** *AI designs and narrates; code measures and referees.*

## 5. Doc map — read what your task needs

| If you are working on… | Read |
|---|---|
| Anything (orientation) | [docs/README.md](docs/README.md), [docs/glossary.md](docs/glossary.md) |
| Product / UX / screens | [docs/product/vision.md](docs/product/vision.md), [docs/product/ux-screens.md](docs/product/ux-screens.md) |
| Why the app exists / business | [docs/product/problem-and-business.md](docs/product/problem-and-business.md) |
| What the AI does and doesn't do | [docs/product/what-ai-does.md](docs/product/what-ai-does.md) |
| Steps / calories / mood | [docs/architecture/wellness.md](docs/architecture/wellness.md) |
| Quests, milestones, XP/rank, guilds, custom modules | [docs/architecture/milestones-and-custom-modules.md](docs/architecture/milestones-and-custom-modules.md) |
| Offline parties, adaptive quests, peer sightings | [docs/architecture/offline-party-mode.md](docs/architecture/offline-party-mode.md) |
| System overview | [docs/architecture/overview.md](docs/architecture/overview.md) |
| Mobile app | [docs/architecture/mobile.md](docs/architecture/mobile.md) |
| Backend API | [docs/architecture/backend.md](docs/architecture/backend.md), [docs/api/api-spec.md](docs/api/api-spec.md) |
| Rules engine / Challenge DSL / modules | [docs/architecture/challenge-engine.md](docs/architecture/challenge-engine.md), [docs/guides/adding-a-module.md](docs/guides/adding-a-module.md) |
| AI Challenge Agent | [docs/architecture/ai.md](docs/architecture/ai.md) |
| Offline, events, sync | [docs/architecture/offline-and-sync.md](docs/architecture/offline-and-sync.md) |
| GPS / geofences | [docs/architecture/location.md](docs/architecture/location.md) |
| Photos / anti-cheat | [docs/architecture/evidence-validation.md](docs/architecture/evidence-validation.md) |
| Auth / security | [docs/architecture/security.md](docs/architecture/security.md) |
| Database | [docs/data/postgres-schema.md](docs/data/postgres-schema.md), [docs/data/sqlite-schema.md](docs/data/sqlite-schema.md) |
| Scope / plan / tests / demo | [docs/delivery/](docs/delivery/) |
| Why a decision was made | [docs/decisions/README.md](docs/decisions/README.md) |

## 6. Conventions

- Product name: **Trina** (তৃণ). Package scope: `@trina/*` (e.g. `@trina/engine`). Bundle id: `app.trina.mobile` (placeholder).
- **TypeScript strict**, ESM. No `any` without a comment explaining why.
- IDs: **UUIDv7** for client-generated entities (sessions, events, evidence, outbox, batches).
- Time: store `timestamptz` / ISO-8601 UTC strings; plus `monoMs` on activity events.
- Units: metres, seconds, points as integers. Coordinates as `[lng, lat]` (GeoJSON order).
- Errors from API: RFC 9457 `application/problem+json` with a stable `code`.
- Naming: files `kebab-case.ts`, types `PascalCase`, DB columns `snake_case`, JSON `camelCase`.
- Tests next to code (`*.test.ts`), Vitest for packages/server, Jest for mobile.
- Commits: Conventional Commits (`feat(engine): …`, `fix(sync): …`).

## 7. Working agreement for agents

- **Before coding:** read `docs/STATUS.md` + the relevant architecture doc.
- **Changing a decision?** Add/modify an ADR in `docs/decisions/` — don't silently diverge.
- **Changing a schema/contract?** Update `packages/contracts`, the matching doc in `docs/data/` or
  `docs/api/`, and bump `schemaVersion` if it's a breaking change to stored/synced data.
- **After coding:** update `docs/STATUS.md` (what changed, what's next).
- **Don't** add new top-level packages without an ADR (we keep the package count small on purpose).
- **Don't** install heavy infra (Redis, Kafka, microservices) for the MVP.
- Keep docs in sync with code — docs are part of the deliverable.

## 8. Commands

```bash
pnpm install                          # install all workspaces
pnpm dev:server                       # API :3000, embedded PGlite + demo seed (no Docker)
pnpm dev:worker                       # standalone worker (only with DATABASE_URL / Postgres)
pnpm --filter @trina/mobile android   # Android dev build (Expo, needs SDK 36)
pnpm -r typecheck && pnpm -w lint
pnpm -r --workspace-concurrency=1 test
pnpm eval:ai                          # AI eval suite (set LLM_BASE_URL for a real model)
```

Where things live in code: offline core `apps/mobile/src/core` (pure TS, tested on node:sqlite),
RN adapters `apps/mobile/src/platform`, screens `apps/mobile/src/screens`, server modules
`apps/server/src/modules/*`, migrations `apps/server/src/platform/migrations.ts`.
