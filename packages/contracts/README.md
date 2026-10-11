# @trina/contracts

Single source of truth for **data shapes**, as zod schemas with inferred TS types. Imported by
mobile, server, engine and ai.

Contents:
- `challenge-definition.ts`: Challenge DSL v1 ([spec](../../docs/architecture/challenge-engine.md#1-challenge-dsl-challengedefinition-v1))
- `challenge-intent.ts`: the small AI output ([spec](../../docs/architecture/ai.md))
- `events.ts`: activity event envelope + discriminated payload union ([spec](../../docs/architecture/offline-and-sync.md#2-event-model))
- `sync.ts`: push/pull protocol
- `api/*.ts`: request/response DTOs ([spec](../../docs/api/api-spec.md))
- `errors.ts`: problem+json codes

Rules: runtime dependencies are only `zod` and `@noble/hashes` (pure-JS SHA-256, identical on device and server). Bump `schemaVersion` on breaking changes to
stored or synced data, and keep backward-compat fixtures.
