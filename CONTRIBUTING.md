# Contributing to Trina

Thanks for helping people touch grass (তৃণ)! 🌱

## Before you start

1. Read [AGENTS.md](AGENTS.md). Its rules apply to human contributors too.
2. Check [docs/STATUS.md](docs/STATUS.md) to see what's being worked on.
3. Look for issues labelled `good first issue` or `new-module`.

## Easiest first contribution: add a challenge module

New outdoor activities (frisbee, birdwatching, stair climbing…) are self-contained folders in
`packages/engine/src/modules/`. Follow [docs/guides/adding-a-module.md](docs/guides/adding-a-module.md).

## Workflow

1. Fork the repo and create a branch: `feat/<area>-<short-name>`.
2. `pnpm install`, then `pnpm -w dev:infra` if you need the backend.
3. Make your change with tests.
4. Run `pnpm -w typecheck && pnpm -w lint && pnpm -w test`.
5. Update docs if you changed behaviour, schemas, or decisions:
   - Schema or contract → `docs/data/*` or `docs/api/*`
   - Architecture decision → `docs/decisions/README.md`
   - Progress → `docs/STATUS.md`
6. Open a PR with a Conventional Commit title (`feat(engine): add frisbee module`).

## Ground rules

- Scoring logic only in `packages/engine`, and it must be deterministic.
- Never let LLM output bypass the compiler and validator.
- Never log coordinates, emails, or tokens.
- Keep the package count small; propose new packages through an ADR.

## Code of conduct

Be kind. Assume good intent. No harassment. Maintainers may remove content or contributors that
violate this.
