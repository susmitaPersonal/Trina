# Glossary

| Term | Meaning |
|---|---|
| **Challenge** | A published, playable outdoor activity definition (e.g. "Green Sprint 60"). Has immutable **versions**. |
| **Challenge version** | An immutable snapshot of a challenge's `ChallengeDefinition`. Participants are **pinned** to the version they downloaded. |
| **ChallengeDefinition / DSL** | The JSON schema describing a challenge: area, checkpoints, tasks, scoring, completion. Defined in `packages/contracts`. |
| **ChallengeIntent** | A *small* JSON object the LLM produces (modules, durations, counts). The deterministic compiler turns it into a ChallengeDefinition. |
| **Module** | A plugin in `packages/engine/src/modules/<id>` defining an activity type (walking, cleanup, tree_care…): params, task types, facts, default rules, plausibility limits. |
| **Task** | Something to do during a challenge (e.g. `cleanup.collect_items`), often requiring **evidence**. |
| **Checkpoint (CP)** | A circular geofence the participant must reach (with dwell time and an accuracy requirement). |
| **Start zone / End zone / Boundary** | Geofences for where a session may start or end, and the permitted play area. |
| **Session (activity session)** | One participant's attempt at one challenge version on one device. Created **on the device**, identified by a UUIDv7. |
| **Event** | An immutable record in a session's append-only log (`SessionStarted`, `LocationBatch`, `TaskCompleted`…). Has `eventId`, `seq`, `prevHash`, `hash`. |
| **seq** | Per-session, gapless sequence number starting at 1. Used for ordering and gap detection. |
| **Hash chain** | `hash = SHA-256(canonical(event) ‖ prevHash)`. Makes post-hoc edits to local data detectable. |
| **monoMs** | Monotonic elapsed milliseconds since session start. Unlike wall-clock time, the user can't change it. |
| **LocationBatch** | An event carrying about 30 GPS samples (instead of one event per fix). |
| **Outbox** | A local SQLite table of pending non-event mutations (join, create draft…), sent with an `Idempotency-Key`. |
| **Offline bundle** | Everything needed to play offline: definition, map pack, rule text, encouragement lines, server time. |
| **Provisional score** | Score computed on the device by the engine. Shown immediately, never authoritative. |
| **Final score** | Score computed by the server engine over **validated, filtered** events. The only authoritative score. |
| **Flag** | A validation finding (`MOCK_LOCATION`, `CLOCK_DRIFT`…) with severity `info`, `warn` or `critical`. |
| **Verdict** | Session validation result: `verified`, `verified_with_notes`, `needs_review`, `rejected`. |
| **Facts** | Values derived from session state (`distance_m`, `checkpoints.required_reached`) that rules evaluate. |
| **Rule** | A data-driven scoring, bonus, penalty or completion condition (closed AST, never `eval`). |
| **Provider (LLM)** | An implementation of `LLMProvider`: `llama-rn` (device), `openai-compatible` (Ollama, llama.cpp, vLLM), `template` (no AI). |
| **Pre-flight** | Checklist run before Start (permissions, GPS accuracy, bundle, start zone…). |
| **Wellness metrics** | Steps, cadence, active minutes, phone-free minutes, estimated kcal, optional mood before/after. Informational only, never scored. |
| **MET** | Metabolic Equivalent of Task. Calories ≈ MET × weight kg × hours. Values come from a table in the engine. |
| **Phone-free minutes** | Minutes of an active session with the app in the background or the screen off. |
| **Activity Mode** | The full-screen, minimal UI during an active session. |
| **Data module** | A module written as `ModuleDefinition` JSON and interpreted by the engine from a closed set of primitives. **Official** (shipped in the repo, e.g. cricket) or **custom** (made by a player at runtime). See [architecture/milestones-and-custom-modules.md](architecture/milestones-and-custom-modules.md). |
| **Milestone** | A data rule that unlocks a tier (unlock / bronze / silver / gold) when facts over a window (session, day, week, lifetime) reach a threshold. Gives titles and XP, never challenge score. |
| **Verification level** | How a fact is known: sensor (Measured), photo (Evidenced), organizer/peer (Confirmed), self-report. Shown on every badge. |
| **Daily Quest** | One of 3 simple daily goals, completed by an **offline quest**: a session played with mobile data and Wi-Fi off. |
| **Day key** | The local date a session belongs to: date of (start − 4 h) in the session's recorded UTC offset. |
| **XP / RP / rank** | XP comes from milestones and quest minutes (with the weekly bonus and penalty). Rank points (RP) come only from verified activity minutes, offline time and photo proof. Ranks: E, D, C, B, A, S, Trina. |
| **Guild** | A persistent group of up to 50 players with a board, a weekly Guild Quest and a timeline digest. |
