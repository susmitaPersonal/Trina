# Project status

> **Every agent and contributor:** read this first, and update it when you finish meaningful work.
> Keep it short. History belongs in git, not here.

**Last updated:** 2026-10-12
**Current phase:** Phases 0–7 implemented (Phase 7: Offline Party Mode: QR-only parties of 2–11, peer sightings + `CHAIN_FORK`, adaptive quest length, AI theme picker). Next: run on a real device and field-test outdoors.
**Target:** Hacktoberfest 2026 submission, end of October 2026

## Verified so far

| Check | Result |
|---|---|
| `pnpm -r typecheck` (contracts, engine, ai, server, mobile) | ✅ all pass |
| `pnpm -r test` | ✅ **638 tests**: contracts 97 · engine 180 · ai 99 · server 102 · mobile core/system 72 · mobile UI 88 ([test report](delivery/test-report.md)) |
| `pnpm smoke` (real server process over HTTP) | ✅ 20/20 checks (incl. milestones, AI module + refusal, custom-module bundle, offline quest, offline party) |
| `pnpm -w lint` | ✅ 0 errors (56 `any` warnings: older untyped DB rows and `useNavigation<any>()`) |
| Server live smoke test (PGlite, seed, login, discover, AI draft fallback) | ✅ |
| Mobile Metro bundles (`expo export --platform android` / `ios`) | ✅ 1,324 / 1,327 modules → Hermes bytecode |
| Mobile `expo prebuild` (config plugins, permissions) | ✅ (background location stripped as designed) |
| AI eval baseline (rule-based builder) | ✅ challenges: 100% on 16 prompts · modules: 48 prompts (EN/BN/HI/adversarial), 100% adherence, 100% unsafe handled, 0% false blocks · themes: 30 prompts (EN/BN/HI/injection), 100% enum-only |
| **Native Android build + run on device/emulator** | ⏳ **not done yet**: this machine lacks SDK 36, NDK, cmdline-tools and an emulator image |
| **iOS build / Simulator** | ⏳ **not done**: Xcode isn't installed (Command Line Tools only) |
| **Maestro device flows** (`apps/mobile/.maestro`) | ⏳ written, **not run** (no device, Maestro not installed) |
| **AI eval against a real self-hosted model (Ollama)** | ⏳ not done yet: Ollama not installed here |
| **Outdoor field test** | ⏳ not done yet |

## Done

- **Phase 0:** pnpm monorepo, TS 6, ESLint, Vitest, CI workflow, docker-compose (Postgres, Ollama, API, worker), `.env.example`.
- **Phase 1:** `@trina/contracts` (DSL v1, events, sync, API DTOs, hashing, UUIDv7); `@trina/engine` (compiler, reducer, facts, rules, wellness, rule text, 8 modules, golden fixtures).
- **Phase 2 (server):** auth (Argon2id, JWT + rotating refresh, reuse detection), challenges (versions, publish, discover nearby, join/teams, offline bundle), leaderboards, impact report (JSON/CSV), admin review, retention jobs.
- **Phase 3 (mobile):** offline core (SQLite event log + hash chain, GPS buffer, evidence binding, provisional scoring, pre-flight, sync status), Expo app with 25 screens, background location task, pedometer, live monitor (haptics and notifications), SVG offline map/compass.
- **Phase 4 (sync):** SyncWorker (outbox, push/upload/pull, backoff, dead letter, crash recovery) plus server ingest and validation pipeline. **End-to-end test: offline play → lost ack → exactly-once sync → verified; device score equals server score.**
- **Phase 5 (AI):** provider abstraction, OpenAI-compatible (self-hosted) provider, template fallback (English, Bengali, Hindi), constrained intent, deterministic compiler, repair loop, patch/difficulty, recap guard, explain; server AI routes; mobile router (device → server → rules); llama.rn provider (optional); eval runner.
- **Wellness:** steps, MET calories, active and phone-free minutes, opt-in mood (separate endpoint, not hash-chained).
- **Phase 6 (2026-10-11, [design](architecture/milestones-and-custom-modules.md), ADR-023 to 031):** Module DSL + Milestone DSL (contracts); data-module compiler, registry merge, cricket + football as official data modules, built-ins expressed in the DSL, per-minute budget 8/12/15, new facts, pure milestone evaluator (day/week/month/lifetime, streaks, 04:00 day key), co-presence, progression (XP, rank E→Trina, +15/−10 weekly), offline quests (engine v2); AI Module Builder with deterministic safety (EN/BN/HI lists), English-only input, template fallback, 48-prompt eval; server migration 3, module/milestone/progress/quest/guild/moderation endpoints, Claims stage (signed confirmations, co-presence, rate, reciprocity, implausible counts), offline-quest checks, exactly-once milestones with revocation; phone migration 2, offline milestones + reconcile, QR confirmation handshake, QuestGuard, Today/Quest Start/Status/History/Module Builder/Module Detail/Confirm/Guilds screens, quote carousel + meadow, unlock notifications.
- **Phase 7 (2026-10-12, [design](architecture/offline-party-mode.md), ADR-032 to 034):** Offline Party Mode (QR only, 2–11 players): signed invites, check words, two-sided peer sightings, CRDT progress gossip, server Party stage with `CHAIN_FORK`; adaptive Daily Quest length; on-device AI theme picker.

## Next up

1. **Run on a device:** install Android Studio (SDK 36 + NDK), then `pnpm android`. Step by step: [guides/android-on-mac.md](guides/android-on-mac.md). APK for testers: `pnpm android:apk` (local) or `build:apk:cloud` (EAS).
2. Field test Green Sprint 60 outdoors on 2 phones; tune geofence radius, dwell and battery. **Also play a 3-phone offline party**: QR scanning in sunlight, multi-frame scan speed.
3. Party goal → milestone XP (owner decision 3 still a default) and offline-quest XP for party sessions ([design §10](architecture/offline-party-mode.md#10-as-built-2026-10-12)).
4. `ollama pull qwen3:4b` → `LLM_BASE_URL=… pnpm eval:ai` → record real-model eval numbers.
5. Optional: add `llama.rn` to the mobile app and benchmark on-device latency (ADR-010).
6. Pick the demo city, then the PMTiles extract (MapLibre is optional; the SVG map works offline).
7. Type the remaining `any` DB rows; **run the Maestro flows** (`apps/mobile/.maestro`) on an emulator and an iPhone simulator.
8. Field-check Phase 6 outdoors: QR handshake in sunlight, time-in-zone and co-presence accuracy, the quest guard after an app kill.
9. Deferred from Phase 6 (demo cut): guild timeline digest + congrats, public custom modules (needs a moderation team), personal tiers.

## Known limitations (honest list)

- Offline parties: party goals are shown but don't give XP yet; party sessions earn no offline-quest XP; QR scanning untested on real cameras.

- Custom-module milestones use the latest module version a player played (two versions of one module in a player's history share one catalogue entry).
- The server can't see other apps using the internet during a quest; "offline time" is what the phone recorded, corroborated only by Trina's own requests.
- Mono clock across app kills is estimated from wall time (flagged on rollback); a native `elapsedRealtime` module would be better.
- Background step counting depends on the OS keeping the JS runtime alive (foreground service); not yet verified on OEM-skinned Android.
- iOS is untested.
- Shared phone: queued offline `outbox` mutations (e.g. a join made offline) aren't tagged with an account; sign out only after syncing. If the player pauses a quest by hand and then the 60 s online guard fires, going offline again resumes it.
- Evidence duplicate detection is exact-hash only (pHash is a SHOULD).
- On-device model download needs a manually pasted GGUF URL (manifest hashes are TBD until the benchmark).

## Changelog (newest first)

- 2026-10-12: **Implemented Offline Party Mode** ([design](architecture/offline-party-mode.md), ADR-032 to 034 accepted; tech-lead suggestion): QR-only parties of 2–11 (signed invite, deterministic rebuild + check words, two-sided sightings, CRDT summary gossip), server Party stage (`CHAIN_FORK`, sighting checks, re-validation), `GET /v1/parties/:id`, adaptive Daily Quest length, on-device AI theme picker (enum only). +100 tests (638 total), smoke 20/20. Not built: party goal → XP. Not yet on a device.
- 2026-10-11: **Kaggle benchmark port** of the Challenge Agent intent eval ([packages/ai/evals/kaggle](../packages/ai/evals/kaggle/README.md)) for the DEV Kaggle Benchmarking Challenge (deadline 2026-10-11 23:59 PDT): 40 cases (faithfulness, unit math, BN/HI, injection, out of scope, ambiguous), self-contained notebook scored by code only (parse/schema/lane/defer/faithful; a lane violation scores 0); rule-based `TemplateProvider` scores 0.968. Published: [Kaggle task](https://www.kaggle.com/benchmarks/tasks/bulaansusmita/trina-stay-in-your-lane), [DEV write-up](https://dev.to/susmita8336biswas/stay-in-your-lane-10-llms-understood-the-request-half-still-tried-to-referee-the-game-ba3); best LLM Gemini 3.7 Flash 0.865 of 10 tested.
- 2026-10-11: **First run on a real Android build** (EAS APK on an Android 13 emulator): offline quest recorded 0 minutes outside, because after start the app dropped to Balanced accuracy, and with Wi-Fi and data off the GPS never turned on. Fixed with a GPS-only `open` sampling profile for sessions with no checkpoint ahead (`apps/mobile/src/platform/session-runtime.ts`, [location.md](architecture/location.md) §3); verified on the emulator (distance and minutes outside count while offline). Demo video recorded from the app.
- 2026-10-11: **Verification pass 5** (mobile + phone→server→phone): 10 bugs fixed with failing-first tests (milestone reconcile on truncated list / after network drop, rejected sessions in provisional views, duplicate confirmation claims, signed QR > 1 KB with 3+ claims → compact `TRINA2:` QR, strict base64, scanner stuck after a wrong code, quest level tier, shared-phone data scoping and sync); chaos-test generator fixed; 538 tests. Still no native build or device run (toolchains missing).
- 2026-10-11: **Implemented Phase 6** (milestones, custom data modules, AI Module Builder, signed confirmations, offline Daily Quests, guilds): 526 tests, 19-check smoke, 48-prompt module eval; fixed 8 bugs found by the new tests (incl. forgeable `OrganizerConfirmation`); ADR-023 to 031 Accepted. No device testing (toolchains missing).
- 2026-10-11: Approved design for offline Daily Quests, milestones, XP/rank, guilds/timeline and runtime custom modules ([doc](architecture/milestones-and-custom-modules.md)); ADR-023 to 031 added as Proposed; Phase 6 planned. No code yet.
- 2026-10-10: Test suite expanded to 339 tests (anti-cheat matrix, compile-error catalogue, geometry, AI router/providers, platform, 15 more screens); fixed rule-text bug; Android guide + EAS/APK scripts; `.nvmrc` (Node 24).

- 2026-10-09: Full test suite (229 tests + live smoke): property, system, chaos and UI tests; fixed 4 bugs they found.

- 2026-10-09: Implemented phases 0–5 (server, engine, AI, mobile app, sync); 73 tests green.
- 2026-10-09: Problem/business, what-AI-does and wellness docs.
- 2026-10-09: Blueprint and docs created.
