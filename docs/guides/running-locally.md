# Running Trina locally

## 1. Prerequisites

- Node 22+ (24 recommended) and pnpm 10 (`corepack enable`)
- For the phone app: Android Studio (SDK **36**, NDK, an emulator or a USB device) and JDK 17–21
- Optional: [Ollama](https://ollama.com) for the self-hosted open-weight AI model

```bash
pnpm install
```

## 2. Server (zero setup)

```bash
pnpm dev:server          # http://localhost:3000, embedded PGlite in apps/server/.data
```

On first start, development mode seeds:
- `organizer@trina.dev` / `touch-grass-2026` (admin)
- `arjun@trina.dev` / `touch-grass-2026`
- a published **Green Sprint 60** at Rabindra Sarobar, Kolkata (change `DEMO_CENTER` in `packages/engine/src/fixtures` for your city)

Check it: `curl localhost:3000/v1/health`.

**With the AI model:**

```bash
ollama pull qwen3:4b
LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen3:4b pnpm dev:server
```

Without Ollama, the AI Builder still works: it says so and uses the built-in rule-based builder.

**With real Postgres:** set `DATABASE_URL=postgres://…` (see `.env.example`). Then run the worker separately with `pnpm dev:worker`, or keep `RUN_WORKER_IN_PROCESS=true`.

**Full stack in Docker:** `JWT_SECRET=$(openssl rand -hex 32) docker compose -f infra/docker-compose.yml up`.

## 3. Mobile app (Android dev build)

> First time on a Mac? Follow [android-on-mac.md](android-on-mac.md) step by step (Android Studio, emulator, fake GPS, APKs).

```bash
cd apps/mobile
# Emulator reaches your laptop at 10.0.2.2; a real phone needs your laptop's LAN IP:
EXPO_PUBLIC_API_URL=http://192.168.1.20:3000 pnpm android     # expo run:android (prebuild + Gradle)
pnpm start                                                    # Metro for later runs
```

- Expo Go is **not** supported: the app needs native modules (background location, SQLite, camera, sensors).
- To test GPS on an emulator, load a GPX route in *Extended controls → Location* (walk the Green Sprint loop).
- To test offline, toggle airplane mode after downloading the challenge.

### Optional: on-device AI (llama.rn)

```bash
pnpm --filter @trina/mobile add llama.rn
pnpm --filter @trina/mobile android         # rebuild the native app
```

Then go to Profile → AI model, paste a Qwen3 GGUF URL, and download it over Wi-Fi. The AI Builder badge switches to "On this device".

## 4. Tests and checks

```bash
pnpm -r typecheck
pnpm -r --workspace-concurrency=1 test       # 73 tests incl. mobile ⇄ server end-to-end sync
pnpm -w lint
pnpm eval:ai                                 # AI eval (rule-based baseline)
LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen3:4b pnpm eval:ai   # real model
cd apps/mobile && CI=1 npx expo export --platform android                 # Metro bundle check
```

## 5. Demo walkthrough

Follow [delivery/demo.md](../delivery/demo.md). Quick version:

1. Sign in on two phones (organizer + Arjun).
2. Organizer: Create → Describe it → "60 minutes for 5 friends, cycle and clean the park" → Use my location → Use this draft → Publish.
3. Arjun: Discover → Join → Download for offline → **airplane mode** → Pre-flight → Hold to start → walk.
4. Finish → turn airplane mode off → Sync pill: "Syncing…" → "Everything is synced." → Results show "Verified" → Leaderboard.
