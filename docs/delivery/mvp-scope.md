# MVP scope

## Demo challenge: Green Sprint 60

A 60-minute walk or cycle loop of about 2–4 km through a park with 4 checkpoints.

| Item | Rule | Points |
|---|---|---|
| Each checkpoint (ordered) | Geofence 30 m, dwell 5 s | 25 × 4 = 100 |
| Litter task at CP2 (`cleanup.collect_items`, qty 10) | Photo of a filled bag | 50 |
| Water a tree at CP3 and CP4 (`tree_care.water_tree`) | Photo per tree within 30 m | 30 × 2 = 60 |
| Distance credit | 1 pt / 100 m, cap 50 | ≤ 50 |
| Completion bonus | All required items done, in end zone, ≤ 60 min | 50 |
| Boundary exit penalty | After 1 grace exit | −10 each |
| **Max** | | **310** |

No speed rewards. Safety cap 15 m/s. Team mode optional (sum).
This challenge is the **golden fixture** for engine tests (`packages/engine/fixtures/green-sprint-60/`).

## MoSCoW

### MUST
- Email auth, refresh rotation, secure storage, device registration
- Challenge DSL v1; engine with `walking`, `cycling`, `cleanup`, `tree_care` modules (+ `running` as a walking variant) and golden tests
- Create from template; Customize with a map pin editor; publish; join; simple teams
- Offline bundle download; compass/route fallback view
- Pre-flight check; while-in-use location; Android foreground service; adaptive sampling
- Event log with seq + hash chain; `LocationBatch`; in-app camera evidence with SHA-256
- Provisional on-device scoring; offline completion screen
- Sync: push, evidence PUT, pull, retries, idempotency, dead letter; Sync Status screen; offline pill states
- Server validation (integrity, temporal, spatial, evidence hash), flags, verdict, final score, per-challenge leaderboard
- **AI Challenge Builder via the provider abstraction using a self-hosted open-weight model (Ollama)**: constrained intent, deterministic compiler, template fallback
- **Wellness basics:** step counting (hardware pedometer), MET-based calorie estimate, active and phone-free minutes, optional mood before/after; wellness card on Results (see [wellness.md](../architecture/wellness.md))
- Retention jobs (samples 30 d, evidence 90 d)
- docker-compose dev environment; CONTRIBUTING + "add a module" guide

### SHOULD
- **On-device inference with llama.rn (Android)** and opt-in model download (the "airplane-mode AI" moment)
- MapLibre offline map packs
- AI patch and variations; encouragement in the bundle; "Explain simply"
- Admin flag review screen; pHash duplicate detection
- Email verification; Keystore-signed completion manifest; SQLCipher
- `scavenger` and `fitness` modules
- `mindful` module (pause / notice / breathe); **AI wellness recap**; profile wellness totals
- Step cadence vs GPS anti-cheat check
- **Challenge impact summary** + CSV export for organisers (`GET /challenges/:id/impact`)

### COULD
- OSM/Overpass checkpoint suggestions; server-side VLM advisory photo check
- `football`, `cricket` (organizer confirmation), `shopping_walk`
- iOS polish and Live Activities; TTS cues; resumable uploads; Play Integrity
- Push notifications (FCM)

### NOT FOR MVP
- Social feed, chat, comments; global or seasonal leaderboards; payments or rewards
- Video evidence; social login; full web app (beyond minimal admin)
- Real-time multiplayer presence; turn-by-turn routing engine; minors' accounts; multi-language AI

## Roadmap after MVP

1. **v0.2:** on-device AI on iOS, OSM-grounded checkpoint suggestions, scavenger hunts, push notifications
2. **v0.3:** organizations (schools, NGOs, residents' associations) with civic impact dashboards; recurring challenges
3. **v0.4:** seasonal leaderboards and badges; peer verification; vision-model advisory checks
4. **v0.5:** routing engine; accessibility routes (wheelchair, stroller)
5. **Later:** self-hosting kits for communities; community module catalog (DSL only, no code)
