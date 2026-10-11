---
name: update-project-docs
description: Keep Trina's docs in sync after code changes: update docs/STATUS.md, phase checklists, ADRs, schema/API docs. Use at the end of a work session, after changing contracts/schemas/endpoints, or when the user says "update docs/status".
---

# Update project docs

1. `git diff --stat` (or review the session's changes) to see what changed.
2. Always update `docs/STATUS.md`: Done / In progress / Next up / blockers, bump "Last updated", one changelog line.
3. Tick completed items in `docs/delivery/phases.md`.
4. If DB tables changed, update `docs/data/postgres-schema.md` or `docs/data/sqlite-schema.md`.
5. If endpoints or DTOs changed, update `docs/api/api-spec.md`.
6. If events, DSL or sync changed, update `docs/architecture/offline-and-sync.md` or `challenge-engine.md`, and check that `schemaVersion` was bumped if the change breaks stored data.
7. If a design decision changed, add or supersede an ADR in `docs/decisions/README.md`. Never silently rewrite history.
8. If a rule in `AGENTS.md` §4 is affected, stop and ask the user before editing it.

Keep docs concise; link rather than duplicate.
