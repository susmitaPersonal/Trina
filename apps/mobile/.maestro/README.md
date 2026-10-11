# Maestro flows (device E2E)

Written for the milestones / custom-modules / offline-quest features. **Not yet run on a device**:
this repo's dev machine has no Android SDK 36 / emulator and no Xcode (see `docs/delivery/test-report.md`).

```bash
# Android emulator or USB phone with a dev build installed, API reachable (adb reverse tcp:3000 tcp:3000)
maestro test apps/mobile/.maestro -e EMAIL=arjun@trina.dev -e PASSWORD=touch-grass-2026
```

| Flow | What it checks |
|---|---|
| `01-daily-quest-offline.yaml` | Today tab → quest start is locked while online → airplane mode on (Android) → quest starts → stop for safety → "no points lost" |
| `02-module-builder.yaml` | Create → Build a new activity → AI draft (kite) shows safety notes and verification labels → save → module detail |
| `03-unsafe-module.yaml` | The builder refuses "rooftop kite flying" with a reason |
| `04-status-and-history.yaml` | Profile → Status (rank, stats, meadow) → Milestones history with verification badges |

`setAirplaneMode` works on Android only; on iOS turn mobile data and Wi-Fi off by hand when the flow pauses.
