---
name: add-challenge-module
description: Scaffold and implement a new Trina challenge module (e.g. frisbee, bird_watching) in packages/engine, with params, task types, facts, rules, golden fixture, registry entry and docs. Use when the user asks to add a new activity/challenge type or module.
---

# Add a challenge module

1. Read `docs/guides/adding-a-module.md` and `docs/architecture/challenge-engine.md` (module contract, DSL).
2. Read an existing module in `packages/engine/src/modules/` (e.g. `cleanup`) and mirror its structure.
3. Confirm with the user: module id (snake_case), task types, evidence, scoring, max plausible speed.
4. Create the files listed in the guide, then register the module in `packages/engine/src/modules/index.ts`.
5. Add a golden fixture `packages/engine/fixtures/<id>-basic/` and unit tests. Run `pnpm --filter @trina/engine test`.
6. Optionally add 3 eval prompts to `packages/ai/evals/prompts.jsonl`.
7. Update the module table in `docs/architecture/challenge-engine.md` and the status in `docs/STATUS.md`.

Hard rules: pure/deterministic (no Date.now, randomness or I/O); bounded params; never reward raw speed on roads.
