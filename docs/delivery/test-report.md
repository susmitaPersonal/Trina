# Test report

**Date:** 2026-10-11 · **Result:** ✅ everything automated passes · ⏳ **no device testing** (toolchains missing, see below)
**Total:** **638 automated tests** + 20-check live smoke test + 94-prompt AI eval (16 challenge + 48 module + 30 theme) + Android and iOS bundle checks

## How to run

Use Node 22+ (24 recommended; the repo has `.nvmrc`).

```bash
pnpm -r --workspace-concurrency=1 test   # all 638 tests (unit, property, integration, system, chaos, UI)
pnpm smoke                               # spawns the real server, drives it over HTTP (19 checks)
pnpm test:ui                             # React Native screen tests only (Jest)
pnpm eval:ai                             # challenge + module eval suites (set LLM_BASE_URL for a real model)
pnpm -r typecheck && pnpm -w lint
cd apps/mobile && CI=1 npx expo export --platform android   # and --platform ios
maestro test apps/mobile/.maestro        # device E2E (needs an emulator/phone; not run yet)
```

## Results

| Package / layer | Files | Tests | Result |
|---|---|---|---|
| `contracts`: schemas, hashing, UUIDv7; **Module/Milestone DSL, ModuleIntent, safety filter (EN/BN/HI), signed confirmations, QR codes, new events, DSL 1.0/1.1** | 4 | 97 | ✅ |
| `engine`: golden runs, cheat cases, property invariants, all modules, geometry; **data modules (valid/invalid/unsafe/farmable), registry merge + versioning, budgets, counters, confirmations, zone dwell, offline time, milestone evaluator, day keys/time zones, streaks, co-presence, progression, quests; party: definition determinism, merge laws (CRDT property), goals, adaptive ladder** | 7 | 180 | ✅ |
| `ai`: pipeline, repair/fallback, router, recap guard; **Module Builder: every schema-valid intent compiles (property), injection/sensor/points rejected, refusals before the model, English-only, eval gate; theme picker (EN/BN/HI, injection, model misbehaviour → rules)** | 5 | 99 | ✅ |
| `server`: every route, authz, privacy, retention, rate limits, anti-cheat matrix; **modules (create/publish/fork/report/moderate/IDOR/idempotency/quotas), AI module drafts, custom-module challenges + bundles, signed confirmations and every Claims flag, offline quests, exactly-once milestones + revocation, guilds, rate limits, retention; **offline parties: invite/definition/role/full checks, every sighting flag, `CHAIN_FORK`, re-validation, members-only goal, adaptive quest length**** | 8 | 102 | ✅ |
| `mobile` core + system: event log, sync, phone ⇄ server; **custom module → offline QR handshake → sync → server agrees; QuestGuard blocks every request; chaos property: exactly-once unlocks and notifications; reconcile rules; pass 5: truncated server list, interrupted reconcile, rejected sessions, 6-claim handshake, shared phone; 3 phones play an offline party over QR only (0 requests) → server verifies all; every bad scan refused; 11-member gossip in ≤ 4 frames** | 9 | 72 | ✅ |
| `mobile` UI: 23 earlier screens + **Today, Quest Start, Status, Milestone History/Detail, Module Builder/Detail, Confirm (ask/scan), Guilds (online/offline), Home carousel, Live quest + counter pad, notification copy, quest runtime grace/pause; pass 5: scanner retry, quest level tier; Party hub/host/join/play (real signed codes), vibe → theme, rank-capped lengths** | 6 | 88 | ✅ |
| **Total automated** | **39** | **638** | ✅ |
| Live smoke (real server process over HTTP) | 1 | 20 checks | ✅ |
| AI eval, challenges (rule-based baseline) | 1 | 16 prompts | ✅ 100% valid / compile / constraints |
| AI eval, modules (rule-based baseline) | 1 | 48 prompts (14 EN, 6 BN, 6 HI, 4 code-mixed, 10 unsafe, 6 injection, 2 ambiguous) | ✅ 100% adherence · 100% valid modules · **100% unsafe handled** · 0% false blocks |
| AI eval, themes (rule-based baseline) | 1 | 30 prompts (EN/BN/HI + 5 injection/empty) | ✅ 100% agreement · 100% enum-only |
| Android JS bundle (Metro, Hermes) | n/a | 1,324 modules | ✅ |
| iOS JS bundle (Metro, Hermes) | n/a | 1,327 modules | ✅ |
| Lint / typecheck | n/a | 5 packages | ✅ 0 errors (56 `any` warnings, mostly older untyped DB rows and `useNavigation<any>()`) |

## New test case catalogue (milestones and custom modules)

| Area | Cases covered |
|---|---|
| **Module DSL** | Valid custom module; rejects unknown keys (`points`), motorised movement, rooftop venue, sensor-verified counters, weights > 5, evidence tasks without photos, non-daylight community modules, duplicate ids, difficulty out of range, expression strings, URLs; random weights/thresholds never crash and are either within bounds or refused (property) |
| **Safety** | Blocks driving/racing, rooftops (EN/BN/HI), rail tracks, fire, alcohol, night, glass manja, offensive and official-looking names; water → private only; kites → required notes that can't be removed; AI concerns only make things stricter (property); private-only risk survives saving (notes) |
| **Anti-farming** | Self-reported counters can't earn points (module and hand-written challenge); per-minute budget 8/12/15 always met by `challengeFromModule` (property, every module × level × duration); no plain-duration rewards; daily threshold bounds |
| **Registry & versioning** | Built-ins expressed in the DSL (all 8 pass the schema); cricket/football official; runtime modules can't shadow ids; same content twice is idempotent; custom modules must be pinned by `definitionHash`; wrong hash refused |
| **Milestones** | Deterministic and order-independent (property); never unlocks without facts (property); no double unlock and adding a session never removes one (property); final mode = verified only (property); 04:00 boundary across IST/UTC/New York; ISO weeks incl. W53; sessions crossing midnight belong to the start day; old apps marked approximate; streaks with rest days; same-place streaks; co-presence same challenge ≥ 10 min |
| **Progression** | Tier XP; self-report 0 XP; 300 daily cap; quest minutes 30–90; +15 weekly bonus; −10 only at 3 force-stop days, never below 0, safety stops ignored; rank from activity/offline/photos only; B needs Evidenced AURA; rank never goes down; confirmations give XP but no rank |
| **Confirmations** | Signature verifies; tampering/wrong key/garbage rejected (property); values can only go down; QR round-trip ≤ 1 KB (property); server: matched only when both sides + registered key + co-present; `CONFIRM_SELF`, `CONFIRM_SIGNATURE_INVALID`, `CONFIRMER_NOT_COPRESENT`, `CONFIRM_RECIPROCAL`, `CONFIRM_RATE`, `CONFIRM_PENDING` → re-validated when the confirmer syncs later; `COUNT_IMPLAUSIBLE`; phone: own claims, finished sessions, wrong challenge, mismatched pinned key, idempotent accept |
| **Offline quests** | Definition hash identical on phone and server (property); no join needed; Start locked while online; QuestGuard blocks every request (0 network calls during the quest); `ONLINE_DURING_QUEST` removes minutes; `OFFLINE_UNRECORDED`; `QUEST_DEFINITION_MISMATCH`; 60 s grace → pause → resume; force/safety stops; daily quest picks identical offline and on the server |
| **Exactly once** | Re-running evaluation never duplicates rows; admin reject → revoked, approve → final again; chaos property (random offline/dropped responses): phone final set == server set, each unlock announced once and confirmed once, no duplicate server rows |
| **Endpoints / authz** | Private/draft modules 404 for others (IDOR), publish/edit by owner only, `PUBLIC_NOT_AVAILABLE`, `STALE_VERSION`, Idempotency-Key required and replayed, quotas (5 modules/day), fork rules, 3 reports suspend, admin-only moderation, takedown → 410 + `module_status` on pull + leaderboard emptied, module drafts rate-limited (10/min, 10/day), guild membership and invite rules, device key set once |

## Verification pass 5 (2026-10-11): mobile and phone → server → phone

Method: every function in `core/{milestones,confirmations,session-manager,offline-store,sync-worker,api-client,migrations}.ts`,
`app/{services,store,milestone-notify,quest-runtime,live-monitor}.ts` and the pass-5 screens was traced by hand with typical,
boundary, adversarial and state-dependent inputs; each ❌ got a failing test first, then a fix. 10 bugs fixed, 1 test bug fixed,
12 tests added. Re-run after the fixes: typecheck ✅ · lint 0 errors · 538/538 tests · smoke 19/19 · AI eval gates ✅ ·
`expo export` Android (1,324 modules) and iOS (1,327 modules) → Hermes bytecode ✅. Flakiness: mobile vitest 6/6, Jest UI 3/3
after the chaos-test fix. **Still no native build, emulator, simulator or device run** (see "Not covered").

| # | Failing case (test) | Root cause → fix |
|---|---|---|
| 15 | >500 final unlocks: older ones flipped to "revoked" on the phone (`milestones-reconcile`: truncated list) | Server list is `LIMIT 500`; phone treated "missing" as revoked → only when the list is complete; otherwise `revokedKeys` from the pull change (`core/milestones.ts` `reconcile`/`revoke`) |
| 16 | Network drops after pull, before `GET /v1/me/milestones` → provisional forever (`milestones-reconcile`: interrupted) | Cursor moved before reconcile → persistent `milestones_reconcile_pending` flag set in the same pass as the change (`core/sync-worker.ts`) |
| 17 | A server-rejected session still filled the meadow, weekly bonus and Daily Quests (`milestones-reconcile`: rejected) | `progress()` forced `verified: true` → `provisionalSummaries()` drops final-rejected sessions |
| 18 | QR-A with the same counter twice was signed and summed twice (`milestones-reconcile`, contracts property) | Schema allowed duplicate refs → `ConfirmationClaims` unique by kind+ref (QR payloads and both events); `lowerOnly` skips repeats |
| 19 | Signed QR-B with **3+ claims** threw "QR payload too large" after `ConfirmationIssued` was already written (contracts property: 6 claims, 65-char refs, Bengali/Hindi/emoji names; mobile 6-claim handshake) | JSON+base64 token ≈ 1.1–1.8 KB → compact binary `TRINA2:` form (worst case ≤ 1 KB), JSON `TRINA1:` still decoded; QR-B built before the event is written |
| 20 | Changing the last QR character could decode to the same bytes (seen as a flaky system test, 3/5) | Base64 decoder ignored non-zero padding bits → strict canonical decoding |
| 21 | After a wrong code, the confirm scanner ignored every later scan (Jest UI) | One-shot `done` flag → resumes after a refusal, ignoring only the refused code |
| 22 | Rank-E player picking 90 min got `hard` (15 pts/min) quests (Jest UI) | Difficulty came from length → rank-based level tier (design §5A.2) |
| 23 | Second account on the same phone saw the first one's milestones, XP, history and guilds; its device key was never registered | Per-user caches weren't scoped → `OfflineStore.onSignIn` resets them on an account switch; summaries/history filtered by user |
| 24 | While account B was signed in, A's unsynced events were pushed with B's token and became permanently `rejected` (`FORBIDDEN`) | Sync wasn't scoped → `SyncWorker` pushes/uploads/counts only the signed-in account's sessions (A's data waits, rule 5) |

Test bug: the chaos property (`test/system.test.ts`) could draw a schedule with **no** successful request (≈1 run in 20) and then
demanded a full sync. Now: with no `ok` it asserts nothing is lost or rejected; otherwise exactly-once sync as before.

## Coverage

| Package | Lines | Branches |
|---|---|---|
| contracts | 98% | 87% |
| engine | 97% | 84% |
| ai | 99% | 88% |
| server | 97% | 79% |
| mobile core (`src/core`) | 92% | 84% |
| mobile UI (`src/screens`, `src/components`, notify/quest runtime) | 82% | 69% |
| new UI files (quests, milestones, modules, confirm, guilds, progress components, quest runtime) | 90% | 76% |
| mobile native adapters (`src/platform`) | n/a: need a real device | n/a |

## Bugs found by the tests (all fixed)

| # | Found by | Bug |
|---|---|---|
| 1–5 | (2026-10-10) | See git history: pause/resume, distance while paused, play-area size, disabled buttons, rule text |
| P1 | Party tests (2026-10-12) | Sighting distance was skipped when the two sides of one handshake were recorded minutes apart: added `SIGHTING_CLOCK` |
| P2 | Party tests | Gossip property test timed out: every merge re-verified every signature (slow on phones too). Added a verified-signature cache keyed by the full signed content |
| 6 | Design review of the code | `OrganizerConfirmation` was written by the participant into their own chain and marked tasks done: forgeable. Now self-report only; real confirmations are signed and two-sided |
| 7 | Server seeding test | The Daily Quest system user made `seedIfEmpty` think the DB was seeded, so dev demo users were never created |
| 8 | Server integration test | A water module drafted as "private only" became shareable after saving (risk came only from the prompt). Risk now also follows the module's safety notes |
| 9 | Engine property test | The Daily Quest picker could repeat yesterday's quests. Now a per-player rotation that never repeats on consecutive days |
| 10 | AI compiler property test | Adding cricket/football to the registry let the Challenge Agent mix data-module tasks and exceed the per-minute budget. The Challenge Agent now composes built-in modules only; data modules use `challengeFromModule` |
| 11 | Existing server test | New routers answered 401 instead of 404 for unknown `/v1` routes. Auth is now scoped to their own paths |
| 12 | UI test | The confirmation screen pre-selected tasks such as "Kept the score". Tasks are now opt-in |
| 13 | Writing server tests | Leaderboards still listed challenges whose module was taken down (ADR-028). Now excluded |
| 14 | Lint | The Bengali/Devanagari detector used a regex range the linter rejects. Now plain code points |

Tests changed because behaviour changed on purpose (not to hide failures): the seed test excludes the `@trina.invalid`
system anchor; the module index count is 10 (8 built-in + cricket + football); the AI compiler property test draws
only built-in task types. Four of my own new tests had wrong inputs (too-short ids, a wrong rank sum, a count type)
and were corrected.

## Known flakiness

Under coverage instrumentation with all UI suites in parallel, a UI test occasionally exceeded its timeout (seen twice in
about six coverage runs; a different test each time). Normal runs: 6/6 green. Not observed in vitest suites.

## Not covered by automation (needs hardware, a model or people)

- **No device testing was done.** This Mac has a partial Android SDK (platform 33 only; this app needs SDK 36), **no NDK,
  no `cmdline-tools`, no emulator image and no phone attached**, and **no Xcode** (only Command Line Tools, so no iOS
  Simulator). Maestro isn't installed. The Maestro flows in `apps/mobile/.maestro/` are written but **not run**.
- Therefore unverified on devices: QR scanning with real cameras, the Android internet panel intent, notifications and the
  Android "Milestones" channel, haptics, the quest guard after an app kill (`resumeQuestGuard`), background GPS, iOS overall.
- A real open-weight model for the Module Builder (no Ollama here): only the rule-based baseline was evaluated.
- Outdoor GPS accuracy for time-in-zone and co-presence; battery.
- `createPgDb` against a real Postgres server (the same SQL runs on PGlite).
- Not implemented (deferred per the design's demo cut): guild **timeline digest and congrats**, public custom modules,
  personal tiers, team-scope milestones beyond co-presence, `xp_ledger` (replaced by `user_progress.daily_xp/weeks`).
