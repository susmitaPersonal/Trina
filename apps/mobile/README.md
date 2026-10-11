# apps/mobile: Trina mobile app

React Native (**Expo SDK 57 dev build**) + TypeScript. Offline-first: **SQLite is the source of truth**
on the device until the server acknowledges.

## Layout

| Path | What | Tested how |
|---|---|---|
| `src/core/` | **Pure TS offline core**: event log + hash chain (`session-manager`), GPS buffering, evidence binding, provisional scoring, `sync-worker` (outbox, push/upload/pull, backoff), `api-client`, `preflight`, `sync-status` | Vitest on `node:sqlite` + **end-to-end against the real server** (`test/e2e-sync.test.ts`) |
| `src/platform/` | Native adapters: expo-sqlite, secure store, files/hash/upload, background location task, pedometer, background sync, llama.rn (optional) | Typecheck + Metro bundle |
| `src/app/` | Wiring (`services`), state (`store`), navigation, live monitor (haptics, notifications, auto-finish), AI router | Typecheck |
| `src/screens/` | All 25 screens (docs/product/ux-screens.md) | Typecheck + manual |
| `src/components/` | Outdoor UI kit, SVG offline map, compass | |

## Run

See [docs/guides/running-locally.md](../../docs/guides/running-locally.md). Short version:

```bash
EXPO_PUBLIC_API_URL=http://<laptop-ip>:3000 pnpm android
pnpm test        # offline core + e2e sync
pnpm typecheck
```

Expo Go is not supported (native modules). Tracking uses **while-in-use** location with an Android foreground
service; `ACCESS_BACKGROUND_LOCATION` is explicitly removed from the manifest.

## Rules specific to this app

- UI never mutates via the API directly: domain services → SQLite → outbox. (Exceptions: auth, discover, leaderboard, server AI.)
- Write to SQLite **before** confirming anything in the UI.
- Never delete unacknowledged events or evidence.
- Tokens and weight only in `expo-secure-store`.
- Scoring only via `@trina/engine`.
