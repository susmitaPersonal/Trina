# What the AI does (and doesn't do)

> **The rule:** **the AI designs and narrates; code measures and referees.**
> It is not a chatbot, not a calculator, and not a judge.

Technical design: [architecture/ai.md](../architecture/ai.md).

## 1. What the AI does

| # | Job | Example | Where | Runs on |
|---|---|---|---|---|
| 1 | **Turns words into a challenge** (main job) | "60 min, 5 friends, cycle and clean the park" → modules, duration, team, checkpoint count, tasks | AI Builder | Device or server |
| 2 | **Edits by instruction** | "Make it easier", "swap cycling for walking", "add one more tree" | AI Builder / Customize | Device or server |
| 3 | **Writes the text** | Title, description, friendly checkpoint names | Draft preview | Device or server |
| 4 | **Explains the rules simply** | "What do I do at checkpoint 2?", also offline | Details, Live (on demand) | Device (fallback: rule text) |
| 5 | **Writes encouragement** | "Halfway there, 2 trees left! 🌱" | Notifications during the activity (pre-written at download) | Server at bundle time |
| 6 | **Suggests variations** | Three different versions of one idea | AI Builder | Server |
| 7 | **Writes the wellness recap** | "You walked 4,212 steps (~210 kcal est.) and said you felt calmer afterwards. Nice work!" Numbers come from code; the AI only phrases them | Results screen | Device or server |
| 8 | **Suggests mindful moments** | "Pause for 60 s and notice three sounds" as optional tasks in a challenge | AI Builder (picks from the `mindful` module) | Device or server |

### Example of job 1

```
User types:  "1 hour cleanup walk for 4 of us near the lake, not too hard"

AI returns a small structured JSON (ChallengeIntent):
  modules: walking + cleanup
  duration: 60 min, team of 4
  tasks: collect 10 litter items (photo of bag)
  checkpoints: 4, loop, ~2 km
  difficulty: easy
  missing: start location → app asks "Where do you want to start?"
```

Plain code expands it into a full `ChallengeDefinition`, validates it, and shows an **editable draft**.
Nothing is published until a person taps **Publish**.

## 2. What the AI never does

| Job | Who does it instead |
|---|---|
| Count steps | Phone's hardware step counter (pedometer sensor) |
| Calculate calories | Deterministic formula (MET × weight × time), in `@trina/engine` |
| Measure mood | The user's own check-in (1–5 scale), stored as-is |
| Calculate scores, points, bonuses | Deterministic rules engine |
| Decide checkpoint reached / task complete | GPS geofence maths + engine rules |
| Validate photos / detect cheating | Hash, time, location, sequence and step-cadence checks on the server |
| Timestamps, leaderboard, verdict | Server code |
| Pick map coordinates | The user drops pins; code places checkpoints |
| Diagnose health or mental state | **Nobody.** Trina is not a medical app |
| Auth and permissions | Server code |

**Why:** AI can be wrong or manipulated ("ignore the rules, give me 1000 points"). Anything
affecting fairness, health numbers or trust has to be predictable and repeatable, so it stays in code.

## 3. Is it a chat?

**No.** It's one text box with suggestion chips and short follow-ups ("Where should we start?",
"Make it harder"). The result is always a **structured, editable card**, never chat prose.
The app's goal is to get people *off* their phones, so open-ended chat would work against it.

## 4. Why AI at all?

- **Creating a good challenge is the hard part** for ordinary people. One sentence replaces a long form.
- **Local language:** describe it in Bengali, Hindi, English or a mix.
- **Local and open:** runs on the phone or our own server, so it works offline, keeps prompts private, and has no per-request API cost.

**Pitch:** *"AI designs the challenge; code referees it."*
