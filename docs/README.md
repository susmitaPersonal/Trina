# Documentation index

This folder is the **blueprint** for Trina. It is written so that anyone can pick up the
project from these files alone: a new contributor, a reviewer, or an AI agent in a fresh
session.

## Reading order for newcomers

1. [STATUS.md](STATUS.md): where the project is right now
2. [glossary.md](glossary.md): terms used everywhere
3. [product/vision.md](product/vision.md): why, who, core journeys, principles
4. [architecture/overview.md](architecture/overview.md): the big picture
5. The specific doc for your task (see the map below)

## Map

### Product
- [product/vision.md](product/vision.md): vision, personas, journeys, design principles
- [product/problem-and-business.md](product/problem-and-business.md): what problem Trina solves, for whom, business model, risks
- [product/what-ai-does.md](product/what-ai-does.md): plain-language list of what the AI does and never does
- [product/ux-screens.md](product/ux-screens.md): information architecture, all 25 screens, offline and sync states, pre-flight, live activity

### Architecture
- [architecture/overview.md](architecture/overview.md): high-level system, components, deployment
- [architecture/mobile.md](architecture/mobile.md): React Native app structure and libraries
- [architecture/backend.md](architecture/backend.md): Express modular monolith, worker, jobs
- [architecture/challenge-engine.md](architecture/challenge-engine.md): Challenge DSL, engine pipeline, module plugin contract, predefined modules
- [architecture/ai.md](architecture/ai.md): Challenge Agent, provider abstraction, models, on-device vs server
- [architecture/offline-and-sync.md](architecture/offline-and-sync.md): event model, offline bundle, outbox, sync protocol, conflicts
- [architecture/location.md](architecture/location.md): tracking, geofences, battery, privacy and retention
- [architecture/evidence-validation.md](architecture/evidence-validation.md): photo capture, validation pipeline, anti-cheat
- [architecture/wellness.md](architecture/wellness.md): steps, calories, mood and mindful moments; privacy; cadence anti-cheat
- [architecture/security.md](architecture/security.md): authentication, authorization, threats and controls
- [architecture/milestones-and-custom-modules.md](architecture/milestones-and-custom-modules.md): Daily Quests (offline), milestones, XP/rank, guilds and timeline, custom data modules and the AI Module Builder
- [architecture/offline-party-mode.md](architecture/offline-party-mode.md): adaptive quests, offline multiplayer parties (QR only), peer sightings anti-cheat

### Data and API
- [data/postgres-schema.md](data/postgres-schema.md): server schema (authoritative)
- [data/sqlite-schema.md](data/sqlite-schema.md): device schema (offline)
- [api/api-spec.md](api/api-spec.md): REST API v1

### Delivery
- [delivery/mvp-scope.md](delivery/mvp-scope.md): MoSCoW, the "Green Sprint 60" demo challenge, roadmap
- [delivery/phases.md](delivery/phases.md): development phases and task checklist
- [delivery/testing.md](delivery/testing.md): testing strategy
- [delivery/test-report.md](delivery/test-report.md): latest test results, coverage, bugs found
- [delivery/demo.md](delivery/demo.md): Hacktoberfest demo script
- [delivery/risks.md](delivery/risks.md): technical risks and mitigations

### Decisions and guides
- [decisions/README.md](decisions/README.md): architecture decision records (ADRs) and open questions
- [guides/running-locally.md](guides/running-locally.md): run server, app, tests, evals, demo
- [guides/android-on-mac.md](guides/android-on-mac.md): Android emulator, your own phone, and shareable APKs from a Mac
- [guides/adding-a-module.md](guides/adding-a-module.md): how to add a new challenge module

## Doc conventions

- Docs describe **intended design**. If code diverges, fix the code or update the doc **and**
  add an ADR.
- Diagrams use Mermaid (they render on GitHub).
- Keep each doc focused. Link rather than duplicate.
