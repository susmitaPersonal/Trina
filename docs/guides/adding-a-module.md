# Guide: adding a challenge module

Modules are the main extension point of Trina and a great first contribution.
Contract reference: [architecture/challenge-engine.md §3](../architecture/challenge-engine.md#3-module-plugin-contract).

## 1. Scaffold

```
packages/engine/src/modules/<id>/
  index.ts          exports the ChallengeModule object
  params.ts         zod params schema
  tasks.ts          task type definitions
  facts.ts          fact extractors (pure)
  rules.ts          defaultRules(params)
  <id>.test.ts      unit tests
packages/engine/fixtures/<id>-basic/
  definition.json   a minimal challenge using the module
  events.json       a recorded or synthetic session
  expected.json     expected ScoreResult
```

Use lowercase snake_case for `<id>` (e.g. `bird_watching`). Task type ids are `<id>.<verb_noun>`.

## 2. Implement

- `paramsSchema`: every input, with bounds (min/max) and sensible defaults.
- `taskTypes`: params, default evidence (photo or none), and how completion is decided from events.
- `factExtractors`: **pure** functions from `SessionState` to facts. No `Date.now()`, no randomness, no I/O.
- `defaultRules(params)`: points for tasks and checkpoints. **Never reward raw speed on public roads.**
- `difficulty(params, level)`: deterministic scaling.
- `plausibility.maxSpeedMps`: the realistic maximum for the activity.
- `aiHints`: a one-line description plus 2–3 example user phrases. These feed the AI prompt and grammar enums.

## 3. Register

Add the module to `packages/engine/src/modules/index.ts`. That single registration automatically exposes it in:
- `GET /v1/modules` (server seeds `challenge_modules`)
- the mobile task editor
- the AI intent grammar (enum of modules and task types)

## 4. Test

- Unit tests for facts and rules.
- A golden fixture (definition, events, expected).
- `pnpm --filter @trina/engine test`
- Optional: add 3 prompts to `packages/ai/evals/prompts.jsonl` that should pick your module.

## 5. Document

Add a row to the predefined modules table in [challenge-engine.md](../architecture/challenge-engine.md#4-predefined-modules).

## Checklist for PR

- [ ] Pure and deterministic (no I/O, clock or randomness)
- [ ] Params bounded; safe defaults
- [ ] No speed rewards on roads
- [ ] Golden fixture passes
- [ ] Docs table updated

## Alternative: a data module (no TypeScript)

Most new activities don't need code. A **data module** is a `ModuleDefinition` JSON (`module/1.0`, ADR-023) built from
closed primitives: a movement profile, counters (self-reported, peer- or organizer-confirmed), task types (photo,
self-report, confirmation), weights and milestones. Two ways to make one:

- **Official (shipped in the repo, reviewed by PR):** add it next to cricket and football in
  `packages/engine/src/modules/data/team-sports.ts` and to `OFFICIAL_DATA_DEFINITIONS`. Tests in
  `packages/engine/src/data-modules.test.ts` check it compiles, fits the 8/12/15 points-per-minute budget and that its
  milestones are within healthy bounds.
- **Custom (made by a player at runtime):** the AI Module Builder (`POST /v1/ai/module-drafts`) or `POST /v1/modules`.

Write TypeScript only when the activity needs custom reducer logic (pace targets, ordered clues, …).
See [architecture/milestones-and-custom-modules.md](../architecture/milestones-and-custom-modules.md).
