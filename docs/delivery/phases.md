# Development phases and task checklist

> Status 2026-10-09: phases 0–5 implemented and tested in code; unchecked items need a real device, outdoors or GitHub.

Timeline: about 4 weeks (October 2026). Tick items here **and** summarize in [../STATUS.md](../STATUS.md).

## Phase 0: Foundations (days 1–2)
- [x] pnpm workspace (`pnpm-workspace.yaml`), root `package.json` scripts, `tsconfig.base.json`
- [x] ESLint + Prettier + Vitest config shared at root
- [x] `infra/docker-compose.yml`: postgres, ollama, api, worker (PGlite for zero-setup dev; ADR-019)
- [x] `apps/server`: Express skeleton, config (zod-validated env), pino, problem+json, `/v1/health`, `/v1/time`
- [x] SQL migrations (ADR-020)
- [ ] `apps/mobile`: Expo dev build running on a physical Android device (JS bundle + prebuild verified)
- [x] Metro configured for the pnpm monorepo (`@trina/*` packages resolve)
- [x] GitHub Actions: install, typecheck, lint, test
- **Exit:** app → API → DB round trip on a real device

## Phase 1: Contracts, engine, server core (days 3–7)
- [x] `@trina/contracts`: ChallengeDefinition v1, events, sync protocol, API DTOs
- [x] `@trina/engine`: geo utils, compile, reduce, facts, rules, evaluate
- [x] Modules: walking, running, cycling, cleanup, tree_care
- [x] Golden fixture: Green Sprint 60 (clean run, partial run, cheat run)
- [x] Server auth (register, login, refresh rotation, logout, devices)
- [x] Challenges CRUD, versions, publish, join/leave, teams, bundle endpoint
- [x] Seed modules and templates
- **Exit:** engine scores fixtures deterministically; auth works from the app

## Phase 2: Offline core, mobile (days 8–14)
- [x] SQLite schema + migrations + repos
- [x] Bundle download (+ map pack if available) and offline-ready badge
- [x] Permission screens; pre-flight checks
- [x] Location task (foreground service), filter, adaptive sampler, geofence evaluator, LocationBatch flush
- [x] EventWriter (transactional seq + hash chain); clock (wall + mono + boot id)
- [x] Screens: Start, Live, Map/Compass, Task List, Checkpoint, Camera/Evidence, Completion
- [x] Provisional scoring with the engine; crash resume
- [x] Step counter (StepsSample events), engine `wellness()` (MET kcal, active and phone-free minutes), mood check-in on Start and Completion
- [ ] **Week-1 de-risking item:** background step counting reliability on Android during the foreground service
- **Exit:** a full Green Sprint walked **in airplane mode** gives the correct provisional score

## Phase 3: Sync and validation (days 15–19)
- [x] Sync worker: push, evidence upload, outbox, pull; backoff; dead letter; single-flight
- [x] Sync pill + Sync Status screen (all states)
- [x] Server: `/sync/push`, `/sync/pull`, evidence PUT (sharp, hash), idempotency middleware
- [x] Job worker (`jobs` table): validate-session pipeline, flags, verdict, scores, leaderboard rebuild
- [x] Results, Leaderboard, History screens
- [x] Retention jobs
- **Exit:** chaos tests pass; leaderboard updates after reconnect

## Phase 4: AI (days 20–24)
- [x] `@trina/ai`: LLMProvider, OpenAICompatibleProvider, TemplateProvider, router
- [x] Intent schema + grammar from registry; compiler intent → definition; repair loop
- [x] Prompts v1 (intent, patch, recap, explain); encouragement lines are deterministic for now
- [x] `/ai/challenge-drafts`, `/ai/models`
- [x] AI Builder + Customize screens
- [x] Eval suite (16 prompts so far; target 50+) + report
- [x] **Stretch:** LlamaRnProvider + model download manager (Android): code done; not benchmarked on a device
- **Exit:** ≥ 90 % valid intents on eval with the server model

## Phase 5: Polish, field test, demo (days 25–28)
- [ ] 3 real outdoor runs on 2+ devices; battery profile (≤ 10 %/h)
- [x] UX polish: Live, Sync, Results
- [x] Authorization tests (foreign sessions, evidence, drafts, admin-only)
- [ ] Full OWASP API Top-10 review
- [x] Docs updated
- [ ] `good first issue` tickets for new modules (needs the GitHub repo)
- [ ] Demo script rehearsed twice; backup video recorded

## Phase 6: Quests, milestones, guilds and custom modules (implemented 2026-10-11; device checks pending)
Design: [../architecture/milestones-and-custom-modules.md](../architecture/milestones-and-custom-modules.md) (ADR-023 to 031). Demo cut marked ★.
- [x] ★ M0 Contracts: `ModuleDefinition`, `MilestoneDefinition`, `ModuleIntent`, challenge DSL 1.1, new events, safety lists
- [x] ★ M1 Engine: movement profiles, `compileModule`, new facts (`zone_dwell_s`, counters, `offline_s`, `photo_proofs`), cricket + football as data
- [x] ★ M2 Engine: `summarizeSession`, `evaluateMilestones`, `coPresence`, progression (XP, RP, rank, weekly bonus/penalty), basic quests
- [x] ★ M3 Server: migration 2, module + milestone + progress endpoints, `evaluate-milestones` job, pull kinds
- [x] ★ M4 Mobile: migration 2, evaluation at session end, Today / Status / History, quote carousel, meadow, notifications
- [x] M5 Signed confirmations: device keys, two-scan QR handshake, Claims stage (★ confirmer-side event only)
- [x] ★ M6 AI Module Builder + safety refusal + 48-prompt eval
- [x] M7 Moderation + quotas (★ takedown only)
- [x] ★ M8 Offline Quest Mode: pre-sync, go-offline gate, `QuestGuard`, pause/stop, request-minute check
- [x] M9 Guilds + board + Guild Quest (★ demo cut) · [ ] timeline digest + congrats (deferred)
- **Exit:** a 30-min Daily Quest played fully offline syncs afterwards with correct XP and milestones on device and server ✅ (system test + smoke; not yet on a device)
