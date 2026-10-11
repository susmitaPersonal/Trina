# Hacktoberfest demo script

**Story:** "Five friends, one hour, no signal, and a fair result." Trina (তৃণ) means grass.

| # | Step | Audience sees | Proves |
|---|---|---|---|
| 1 | **Airplane mode ON** → AI Builder → "60-minute challenge for 5 friends: cycle and clean our park" | Badge "On this device · Qwen3-1.7B"; structured draft; validator adjusts an unrealistic distance | **Local open-weight AI** without the cloud; AI grounded by rules. *Fallback if on-device isn't ready: run online against self-hosted Ollama and show the model badge* |
| 2 | Place start pin, accept checkpoints, publish (Wi-Fi on briefly) | Customize + validator panel | Human in the loop |
| 3 | Second phone joins via link → **Download for offline** | "Ready offline ✓" | Bundle |
| 4 | **Disconnect** and go outside | 🟠 "You're offline. Your progress is safe on this device." | Offline UX |
| 5 | Pre-flight → Start | Checklist ticks, start zone ✓ | Deterministic gating |
| 6 | Pocket the phone and walk | Lock-screen notification updates; haptic at checkpoint | "Phone away" design |
| 7 | Litter bag and tree photos | "Saved on device" | Evidence binding |
| 8 | Finish | Provisional score offline | Same engine on device |
| 9 | **Reconnect** | "Syncing 42 activities… 3 photos…" → "Everything is synced." | Auto sync, idempotency |
| 10 | Server validates | Results "Verified" + breakdown; leaderboard updates on both phones | Authoritative scoring |
| 10b | Wellness card | "4,212 steps · ~210 kcal (est.) · 48 of 60 min phone-free · mood 🙂 → 😄" plus the AI recap | Touch-grass benefit; AI narrates, code measures |
| 11 | Bonus: replay a cheat fixture (teleport + reused photo) | "Under review: checkpoint 3 couldn't be confirmed; photo matches another submission" | Honest anti-cheat |
| 12 | Show the repo: `packages/engine/src/modules/` + "Add a module in 30 minutes" | n/a | Extensibility, contributor path |

## Prep checklist
- [ ] Models pre-downloaded on both phones; Ollama warmed up on the server
- [ ] Challenge bundle and map pack downloaded the day before
- [ ] Demo route walked once on the day (GPS check)
- [ ] Backup: recorded field video, emulator with GPX replay, pre-seeded leaderboard
- [ ] Phones charged; battery optimization disabled for Trina
