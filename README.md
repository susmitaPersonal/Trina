# 🌱 Trina (তৃণ)

**Real-world outdoor challenges. Offline-first. Local open-weight AI.**
*Trina* (তৃণ) is Bengali for **grass**. A Hacktoberfest 2026 project for the "Touch Grass" theme.

> Use the phone for two minutes, spend sixty outside.

Create a challenge ("60 minutes, 5 friends, cycle the park and pick up litter"), let a
**local open-weight AI** turn it into a playable challenge, download it, go outside, and play it
**completely offline** with GPS checkpoints and photo evidence. Once you're back online it
**syncs automatically**, the server **validates** it with deterministic rules, and the
**leaderboard** updates.

**New this week:** offline **Daily Quests** (turn the internet off, go outside, your minutes count),
**milestones** with honest verification labels (Measured · Evidenced · Confirmed · Self-reported),
XP and ranks from E to **Trina**, **cricket and football**, and an **AI Module Builder**: describe a new
activity ("kite flying with friends") and a local open-weight model drafts it, while plain code sets every
number and refuses unsafe ideas ("rooftop kite flying" → refused, with the reason).

## Why it's interesting

- **Offline-first:** SQLite on the device is the source of truth, with an append-only event log,
  an outbox, and an idempotent sync protocol.
- **Local AI that matters:** an open-weight model (on-device via llama.cpp, or self-hosted) turns
  natural language into a structured challenge. Deterministic code makes every scoring and
  validation decision.
- **Pluggable challenge modules:** built-in TypeScript modules plus **data modules** (JSON the engine
  interprets: no code, no eval) that players can create at runtime with the AI Module Builder.
- **Fair by construction:** points budget per minute by level, self-reported counts earn titles only,
  teammates confirm catches and goals by a **signed QR handshake that works offline**.
- **Privacy by design:** no home locations, coarse discovery, and raw GPS that expires.
- **Honest anti-cheat:** it flags suspicious sessions and never claims perfect detection.

## Repository

| Path | What |
|---|---|
| [`apps/mobile`](apps/mobile/README.md) | React Native (Expo dev build) app |
| [`apps/server`](apps/server/README.md) | Node + Express + PostgreSQL API and validation worker |
| [`packages/contracts`](packages/contracts/README.md) | Shared zod schemas (DSL, events, API) |
| [`packages/engine`](packages/engine/README.md) | Deterministic challenge/scoring engine |
| [`packages/ai`](packages/ai/README.md) | Model-agnostic AI layer |
| [`infra`](infra/README.md) | Local infrastructure (Docker) |
| [`docs`](docs/README.md) | Product, architecture, data, API, delivery docs |

## Start here

- **Humans:** [docs/README.md](docs/README.md), then [CONTRIBUTING.md](CONTRIBUTING.md)
- **AI agents and assistants:** [AGENTS.md](AGENTS.md)
- **Current progress:** [docs/STATUS.md](docs/STATUS.md)

## Quick start

```bash
pnpm install
pnpm dev:server                 # API on :3000 with an embedded DB and demo data (no Docker needed)
pnpm -r --workspace-concurrency=1 test   # 526 tests (unit, property, server, system, chaos, UI)
pnpm android                    # Android build + install (setup: docs/guides/android-on-mac.md)
```

Demo login: `arjun@trina.dev` / `touch-grass-2026`. Full guide: [docs/guides/running-locally.md](docs/guides/running-locally.md).

## Status

✅ Implemented: server, engine, AI, mobile app, offline sync, Daily Quests, milestones, custom modules, guilds. Next: real-device and outdoor testing. See [docs/STATUS.md](docs/STATUS.md).

## License

TBD (MIT or Apache-2.0 recommended; see [ADR-012](docs/decisions/README.md)).
