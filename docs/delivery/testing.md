# Testing strategy

> **Latest results:** [test-report.md](test-report.md) (339 automated tests + live smoke + AI eval, all passing).

| Layer | Approach | Tooling |
|---|---|---|
| **Engine** | Unit tests per module. **Golden tests**: recorded event logs (JSON) → expected `ScoreResult`. Property tests: determinism (same input gives same output), score bounds (0 ≤ total ≤ maxScore), seq-order handling | Vitest, fast-check |
| **Contracts** | Schema round trips; backward-compat fixtures for each `schemaVersion` | Vitest |
| **Server** | Integration tests on in-memory PGlite (real Postgres SQL); authz/IDOR suite; rate limits; uploads (bad magic bytes, oversized, corrupt, WebP); retention; token expiry | Vitest + supertest |
| **Sync** | Shared contract tests. **Chaos:** drop the response after commit, duplicate batches, out-of-order batches, seq gaps, 401 mid-sync, kill mid-upload. Expectation: exactly-once effects | Vitest (server) + Jest (client) with fault-injecting fetch |
| **Validation** | Synthetic cheat fixtures (teleport, mocked flag, clock rollback, reused photo, hash mismatch) → expected flags. Clean fixtures → `verified` (watch false positives) | Vitest |
| **Mobile units** | Event log, GPS buffering, outbox, backoff, pre-flight, API client (on node:sqlite) | Vitest |
| **Mobile UI** | Real screens rendered with mocked native modules and real engine snapshots | Jest + jest-expo + Testing Library (`apps/mobile/ui-tests`) |
| **System + chaos** | N phone cores ⇄ real server; random network failures must give exactly-once sync | Vitest + fast-check (`apps/mobile/test/system.test.ts`) |
| **Live smoke** | Real server process driven over HTTP | `pnpm smoke` |
| **Mobile E2E on device** | Flows including airplane-mode toggles; **GPX replay** on the Android emulator (TODO: needs SDK 36 + emulator) | Maestro, emulator mock location |
| **AI** | Eval suite of 50+ prompts (phrasing variety, English/Bengali/Hindi mixes, adversarial). Metrics: schema validity, enum adherence, constraint adherence, latency per model. Nightly and on any prompt or model change | `packages/ai/evals` runner (Node) |
| **Field** | 3+ real sessions on 2+ Android devices: battery, GPS quality, sunlight UX | Manual checklist |
| **Security** | Dependabot, secret scanning, OWASP API Top-10 review | GitHub |

## Fixtures

- `packages/engine/fixtures/<challenge>/<case>/{definition.json, events.json, expected.json}`
- Real field sessions can be exported from the app (debug menu) and added as fixtures after anonymizing (coordinates shifted).
