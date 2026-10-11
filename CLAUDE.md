# CLAUDE.md

@AGENTS.md

## Claude-specific notes

- `AGENTS.md` (imported above) is the canonical guide; keep project rules there, not here.
- Start every session by reading [docs/STATUS.md](docs/STATUS.md).
- Project skills live in `.claude/skills/`:
  - `add-challenge-module` — scaffold a new challenge module in `packages/engine`.
  - `update-project-docs` — keep STATUS / ADRs / schema docs in sync after a change.
- When spawning sub-agents, pass them: the task, the relevant doc paths from the AGENTS.md doc
  map, and the non-negotiable rules (§4 of AGENTS.md). Sub-agents do not inherit this context.
- Don't run `pnpm install` or start Docker without the user's go-ahead in a new session.
