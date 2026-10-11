# Technical risks

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| OEM battery killers stop tracking (Xiaomi, Oppo, Samsung) | High / High | Foreground service; battery optimization step in pre-flight with deep links; `GpsSignalLost` gap detection; test on 2–3 real devices |
| On-device LLM integration, memory, speed | High / Medium | Small intent + grammar; server AI is MUST and on-device is SHOULD; 0.6–1B tier; template fallback |
| Small-model JSON quality | Medium / Medium | Grammar-constrained decoding, registry enums, repair loop, eval gate |
| GPS accuracy in cities or under trees | High / Medium | Accuracy-aware geofences, dwell + 2 fixes, manual confirm (low confidence), 30 m radii |
| Offline tile sourcing and licensing | Medium / Medium | Self-hosted PMTiles regional extract; compass fallback; OSM attribution |
| iOS background limits | Medium / Medium | Android first; while-in-use + background mode; document limits |
| Clock or offline tampering | Medium / Low | Monotonic clock, server anchor, hash chain, honest flags |
| Expo + pnpm monorepo / Metro resolution | Medium / Low | Few packages; set up on day 1; CI builds the app |
| Scope creep (10 modules, 25 screens) | High / High | Strict MoSCoW; one polished challenge type; only Live, Sync and Results get full polish |
| Safety and liability (traffic, trespass) | Low / High | Safety acknowledgement, no speed rewards, daylight default, creator guidelines, takedown |
| Demo-day connectivity | Medium / High | Everything pre-downloaded; offline-first by design; GPX replay backup |
