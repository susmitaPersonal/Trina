# Architecture decision records (ADRs)

Status values: **Accepted** (agreed), **Default** (recommended and in use until the owner confirms
or overrides it), **Proposed**, **Superseded by ADR-x**.

**To change a decision:** add a new ADR that supersedes the old one. Don't edit history silently.
Agents: if your work conflicts with an ADR, stop and raise it instead of diverging.

| ADR | Decision | Status |
|---|---|---|
| 001 | pnpm-workspaces monorepo: `apps/{mobile,server}`, `packages/{contracts,engine,ai}` | Accepted |
| 002 | React Native via **Expo dev builds** (not Expo Go, not bare RN CLI) | Default |
| 003 | **Android first** for the MVP and demo; iOS best-effort | Default |
| 004 | Same pure-TS engine on device (provisional) and server (authoritative) | Accepted |
| 005 | Append-only, hash-chained, per-session event log; UUIDv7 ids; `LocationBatch` | Accepted |
| 006 | PostgreSQL + **PostGIS**, **pg-boss** for jobs (no Redis), **MinIO/S3** for photos | Superseded by 019/020 |
| 007 | Challenge rules stored as **versioned jsonb** (immutable versions), with geo projections | Default |
| 008 | **Drizzle ORM** on both server and mobile | Superseded by 020 |
| 009 | LLM emits a small grammar-constrained `ChallengeIntent`; a deterministic compiler expands it; the LLM never outputs coordinates | Accepted |
| 010 | Server-side self-hosted AI is MUST; on-device (llama.rn) is SHOULD | Default |
| 011 | Default model family **Qwen3** (Apache-2.0): 1.7B on device, 4–8B on server, pending week-1 benchmark | Default |
| 012 | License: Apache-2.0 or MIT for the repo | Proposed |
| 013 | Retention: raw GPS 30 days, photos 90 days, AI prompts 30 days | Default |
| 014 | No server call is needed to start a session; sessions are created by sync | Accepted |
| 015 | Maps: MapLibre + self-hosted PMTiles of the demo region; compass fallback | Superseded by 021 |
| 016 | Auth: email+password, Argon2id, JWT 15 min + rotating opaque refresh 30 d; roles `user`/`admin` | Accepted |
| 017 | Product name **Trina** (তৃণ, Bengali for "grass"); package scope `@trina/*` | Accepted |
| 019 | **Zero-setup DB:** embedded **PGlite** by default, real Postgres via `DATABASE_URL`; plain lat/lng columns + engine geo maths (no PostGIS in MVP) | Accepted |
| 020 | **Plain parameterized SQL** behind a tiny `Db` interface (server) / `SqlDb` (mobile) instead of an ORM; a Postgres **`jobs` table** queue instead of pg-boss; **local-filesystem** evidence storage behind a `Storage` interface (S3 later) | Accepted |
| 021 | **Tile-free SVG vector map + compass** as the offline map; MapLibre/PMTiles optional | Accepted |
| 022 | Mood check-ins travel via `PUT /v1/sessions/:id/mood` (opt-in), never in the hash chain | Accepted |
| 018 | **Wellness** (steps, calories, mood): sensors + deterministic code measure; AI only narrates; wellness never affects score; weight device-only; mood opt-in and not an event | Default |
| 023 | **Declarative data modules:** custom and official non-core modules are `ModuleDefinition` JSON interpreted by the engine from a closed primitive catalogue; no generated code; built-in TS modules coexist; cricket and football ship as official data modules | Accepted |
| 024 | **Milestones and progression are derived and separate from score:** never stored as events; XP/stats/rank never feed challenge score; self-reported = title only; rank only from activity minutes, offline quest time and photo proof (never confirmations); ranks E → S → Trina; rank never goes down | Accepted |
| 025 | **Day key** = local date of (session start − 4 h) using the UTC offset recorded in `SessionStarted`; a session belongs to its start day; server time correction is final | Accepted |
| 026 | **Signed two-sided confirmations** (Ed25519 device keys, two-scan QR handshake, `ConfirmationIssued` / `ConfirmationReceived`); `OrganizerConfirmation` deprecated and treated as self-report; adds `@noble/curves` to contracts | Accepted |
| 027 | **AI Module Builder:** the LLM emits only a `ModuleIntent` (enums, labels, concerns), never numbers, points, thresholds, ids or `sensor` verification; thresholds come from deterministic tables; safety is deterministic and can only add restrictions; server-first; English-only input for now | Accepted |
| 028 | **Custom module visibility and leaderboards:** private/unlisted only in the MVP; point budget 8 / 12 / 15 per minute by challenge difficulty; global board ranks verified outdoor minutes only; takedown policy | Accepted |
| 029 | **Versioning:** module DSL `module/1.0` separate from the challenge DSL; challenge DSL 1.1 (additive); `ENGINE_VERSION` 2; the server deploys before clients send new event types | Accepted |
| 030 | **Offline Quest Mode:** Daily Quests run with mobile data and Wi-Fi off; the app asks (it can't switch them off) and blocks all its own traffic during a quest; sync before and after; online mid-quest pauses after 60 s; offline time recorded as events and checked against server request minutes; +15 XP for 3+ days of 90 min in a week; −10 XP for force stops on 3+ days in a week (safety stops exempt) | Accepted |
| 031 | **Guilds and timeline:** persistent groups (≤ 50 members, ≤ 5 guilds per player, invite only), guild boards and Guild Quests; timeline is a daily digest without places, routes, photos or times, on by default with per-guild opt-out; fixed congrats messages delivered after the receiver is online | Accepted |
| 032 | **Adaptive quests:** a fixed engine ladder over measured history picks minutes, tier and task count; the AI may only pick a theme/task-hint enum and narrate; the server checks bounds ([design](../architecture/offline-party-mode.md)) | Accepted |
| 033 | **Offline party (QR only, 2–11 logged-in players):** host-created missions shared as a signed parameter invite (QR); every device rebuilds and hash-checks the definition; per-player chains, no shared state; progress spreads as signed max-seq summaries (CRDT gossip); party goals give milestone XP only, never score or rank | Accepted |
| 034 | **Peer sightings:** two-sided signed QR sightings cross-link players' chain heads (`CHAIN_FORK` detection) and give offline co-presence; payloads carry no coordinates | Accepted |

## Context and consequences (short)

- **019:** No Docker on the dev machine; contributors must be able to `pnpm dev:server` with nothing installed. PGlite is real Postgres compiled to WASM, so the same SQL runs in tests, dev and prod. Discovery uses a bounding-box prefilter plus haversine. Consequence: PGlite is single-connection, so the worker runs in-process; use Postgres for multi-process deployments.
- **020:** Fewer moving parts and fully explicit SQL (easy to review for injection). The same interface lets mobile tests run on `node:sqlite`. Consequence: hand-written migrations; row types are partly `any` (cleanup item).
- **021:** MapLibre needs tiles plus a native module, which is risky for the MVP. The SVG map shows exactly what matters (start, checkpoints, boundary, track, you) with zero data. Consequence: no street context unless MapLibre is added.
- **022:** Rules can auto-finish a session before the "how do you feel now?" prompt; mood must stay private and out of anti-cheat data.

- **001:** One language, shared contracts and engine. Fewer packages means less Metro friction. Consequence: new packages need an ADR.
- **002:** Native modules (llama.rn, MapLibre, background location) plus maintained Expo modules. Consequence: contributors need a dev build, not Expo Go.
- **004:** Instant offline feedback and a single implementation of the rules. Consequence: the engine must stay pure (no Node or RN APIs).
- **005:** No conflicts for activity data; tamper evidence; exact replay. Consequence: corrections are new events.
- **006:** Minimal infrastructure that fits in one docker-compose. Consequence: re-evaluate the queue when load exceeds Postgres comfort.
- **007:** Flexible across modules, trivial versioning. Consequence: queries on rule internals need projections.
- **009:** Small models are reliable at small constrained outputs; correctness lives in code. Consequence: richer creativity requires compiler work, not prompt work.
- **010:** Protects the demo if on-device integration slips. *Flip it if airplane-mode AI is non-negotiable for the pitch.*
- **018:** Steps from the hardware pedometer and calories from a MET formula are accurate enough, cheap and explainable; an LLM estimating them would be wrong and untrustworthy. Mood is self-reported and sensitive, so it's opt-in and kept out of scoring (otherwise people would fake it). Consequence: a new permission (activity recognition), the engine gains `wellness()`, and the "not medical advice" copy is required.
- **014:** Offline start is a hard requirement. Consequence: the server learns about sessions late; the UI handles that.

- **023–031:** Design in [architecture/milestones-and-custom-modules.md](../architecture/milestones-and-custom-modules.md) (approved and implemented 2026-10-11; guild timeline/congrats and public modules deferred). Context: players want team sports, simple daily quests and their own activities without app releases, while AGENTS.md §4 keeps the LLM out of every number and verdict. Data modules are interpreted, never executed. Milestones are recomputed from validated sessions, so a modified client can't write unlocks. Today's `OrganizerConfirmation` is written by the participant themselves and could be forged, which ADR-026 fixes. Offline quests can't force the phone offline (Android 10+ and iOS forbid it), so they ask, record and corroborate instead. Consequences: `ENGINE_VERSION` 2, challenge DSL 1.1, new events, server migration 2, mobile migration 2, a new contracts dependency.

## Open questions

1. Confirm the ADRs marked **Default** (002, 003, 007, 010, 011, 013, 018).
2. **Demo city/region?** Needed for the PMTiles extract and the demo route.
3. Is airplane-mode on-device AI a must for the pitch (would flip ADR-010)?
4. Repo license (ADR-012)?
5. Hosting for the demo backend (local laptop, a VM, or a cloud provider)?
