# Wellness: steps, calories, mind refreshment

> **Principle:** wellness numbers are **measured by sensors and calculated by deterministic code**.
> The AI only **phrases** a friendly recap from numbers it is given. It never estimates or invents them.
> Wellness metrics are **informational**: they don't affect challenge scores, and they're not medical advice.

## 1. What we track

| Metric | Source | Computed by | Shown where |
|---|---|---|---|
| **Steps** | Phone's hardware step counter (pedometer) | Device: counter delta | Live (small), Completion, Results, Profile |
| **Cadence** (steps/min) | Steps ÷ moving time | `@trina/engine` | Results; anti-cheat signal |
| **Active minutes / time outdoors** | Session events | `@trina/engine` | Results, Profile |
| **Distance** | GPS (already tracked) | `@trina/engine` | Everywhere |
| **Estimated calories** | MET formula | `@trina/engine` (`wellness/calories.ts`) | Completion, Results, Profile |
| **Mood before / after** | Optional 1–5 check-in (emoji) | Stored as-is | Start, Completion, Results |
| **Mindful moments** | `mindful` module tasks (self-report) | Engine (task done) | Task list, Results |

## 2. Steps

- **Android:** the hardware `TYPE_STEP_COUNTER` sensor (cumulative since boot; low power; keeps counting while the screen is off). Read at `SessionStarted`, every 60 s, and at `SessionCompleted`. Needs the runtime permission `ACTIVITY_RECOGNITION` (Android 10+).
- **iOS:** CoreMotion pedometer (`CMPedometer`) queried for the session window. Needs `NSMotionUsageDescription`.
- **Library:** start with `expo-sensors` Pedometer. If background reads on Android aren't reliable during the foreground service, add a small native module or Health Connect. **Week-1 de-risking item.**
- Recorded as `StepsSample` events `{cumulative, delta, monoMs, source}`. A reboot (counter reset) is detected via `bootId` and handled as a new baseline.
- **Pre-flight:** the activity-recognition permission is a **warning, not a blocker**. Without it, steps show "not available".

## 3. Calories (estimate)

Formula (standard MET method; values from the Compendium of Physical Activities, approximate):

```
kcal = Σ over segments ( MET(activity, speed) × weightKg × hours )
```

| Activity / speed | MET (approx.) |
|---|---|
| Standing / light cleanup work | 2.5–3.5 |
| Walking ~4 km/h | 3.0 |
| Walking ~5 km/h (brisk) | 3.5–4.3 |
| Running ~8 km/h | ~8 |
| Running ~10 km/h | ~10 |
| Cycling leisure < 16 km/h | ~4–6.8 |
| Cycling 16–19 km/h | ~6.8–8 |

- Segments come from GPS speed and the module (e.g. a cleanup task's dwell time uses the cleanup MET). The table lives in the engine as data: deterministic and unit-tested.
- **Weight is optional** (Profile). If it isn't set, use 70 kg and label the result **"approx."**. **Weight stays on the device only.** Only the resulting kcal estimate syncs.
- Always shown as `~210 kcal (estimate)`. Never presented as precise.

## 4. Mind refreshment

| Feature | Design |
|---|---|
| **Mood check-in** | Optional 1-tap 5-emoji scale ("How do you feel?") on **Challenge Start** and **Completion**. Skippable. Stored in `sessions.wellness_json` on the device (not an event, not in the hash chain). Synced inside `SessionCompleted` only if opted in |
| **Mood delta** | after − before, shown on Results ("You felt better after 🌱") |
| **Mindful moments** | `mindful` module with task types `mindful.pause` (stop for 60 s and look around), `mindful.notice` (notice 3 sounds or colours), `mindful.breathe` (guided 4-7-8 via haptics, no screen). Self-reported; no evidence; **0 or small fixed points** so they can't be farmed |
| **Phone-free time** | Minutes with the screen off during the session (from `AppBackgrounded`/`AppForegrounded`). Celebrated: "48 of 60 minutes phone-free" |
| **AI recap** | Narrative from the computed numbers (see [ai.md](ai.md)) |

**Mood never affects score or leaderboard.** Rewarding mood would invite fake answers.

## 5. Privacy and safety

| Data | Stored | Sync | Retention |
|---|---|---|---|
| Weight | Device only (secure store) | **Never** | Until the user deletes it |
| Steps, calories, active minutes | Device + server | Yes (part of session results) | With session |
| Mood check-ins | Device | **Opt-in** ("Share wellbeing data", default **off**) | With session; deletable |
| Org reports | n/a | Only **aggregated** mood/steps (minimum group size 5) | n/a |

- In-app copy: "Calories and steps are estimates. Trina is not a medical or mental-health app."
- No diagnosis, no medical claims, no notifications about weight.
- Mood questions are neutral and optional, never required to start or finish.

## 6. Anti-cheat bonus: step cadence vs GPS

Steps give an independent signal the server can cross-check:

| Pattern | Likely meaning | Flag |
|---|---|---|
| Walking/running module, GPS moving at 1–3 m/s, cadence 0 for > 5 min | Riding a vehicle, or a spoofed route | `STEPS_GPS_MISMATCH` (warn) |
| Cadence > 220 spm sustained | Phone being shaken | `CADENCE_IMPLAUSIBLE` (warn) |
| Steps unavailable (no permission or sensor) | n/a | No flag; the check is skipped |

Cycling modules skip the cadence check, since cycling produces few steps.

## 7. Where it touches the system

- **Events:** `StepsSample`; mood rides in `SessionCompleted` when opted in ([offline-and-sync.md](offline-and-sync.md#2-event-model))
- **Engine:** `wellness/` (calories, cadence, active minutes, phone-free minutes) plus the `mindful` module ([challenge-engine.md](challenge-engine.md))
- **Validation:** the cadence checks above ([evidence-validation.md](evidence-validation.md))
- **DB:** `session_wellness` (PG), `sessions.wellness_json` (SQLite)
- **API:** `GET /sessions/:id` includes `wellness`; `GET /me/wellness` for profile totals ([api-spec.md](../api/api-spec.md))
- **UX:** mood check-in on Start and Completion; wellness card on Results; totals on Profile
