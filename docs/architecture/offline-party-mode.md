# Offline Party Mode: adaptive quests, offline multiplayer, peer attestations

> **Status: Implemented 2026-10-12 (phases 7a–7d), QR only.** ADR-032 to 034. Owner decisions in §9; what changed while
> building it, and what is not built yet, in §10. Verified by unit, server-integration, phone⇄server system, UI and smoke tests;
> **not yet on a real device**.
> Origin: tech-lead review: *"Push it farther with adaptive AI quests, offline multiplayer, and stronger anti-cheat
> validation. The real challenge is making AI-generated missions work collaboratively across devices without internet."*
>
> Read first: [offline-and-sync.md](offline-and-sync.md), [evidence-validation.md](evidence-validation.md),
> [milestones-and-custom-modules.md](milestones-and-custom-modules.md) §3.7, §4.4–4.5, §5A, §6A.

## 0. Summary

| Ask | Design in one line |
|---|---|
| **Adaptive AI quests** | A pure engine ladder picks the numbers from the player's measured history; the AI picks only a theme from an enum and narrates |
| **Offline multiplayer** | One **host** phone creates the mission; a **~300-byte signed invite** (QR) carries only parameters; every phone rebuilds the identical definition and checks its hash. Each player keeps their **own** hash chain; party progress spreads phone-to-phone as signed summaries over QR scans (gossip) |
| **Stronger anti-cheat** | Two-sided signed **peer sightings** made when phones meet (QR scans) **cross-link the players' hash chains**, give offline proof of co-presence, and let the server detect a rewritten chain |

**Why this is hard, and the key idea.** If every phone ran the AI, each would invent a *different* mission, and nothing could
reconcile them offline. So the AI runs **once, on the host**, and its output is reduced to a tiny set of **enum and tier
parameters**. A deterministic compiler (same engine everywhere) turns those parameters into the same `ChallengeDefinition` and
the same `definitionHash` on every phone. This is the existing Daily Quest trick (§5A.2: "server rebuilds from the template and
compares the hash"), extended from phone-to-server to phone-to-phone.

All non-negotiable rules hold: the LLM outputs no numbers and no coordinates (rules 1–2); scoring stays in the engine (3);
everything new is an append-only event (4); starting and playing never need the network (6); parties are created by sync (ADR-014).

## 1. Concepts

| Term | Meaning |
|---|---|
| **Party** | An ad-hoc group of 2–11 logged-in players physically together, playing one mission offline. Identified by a client UUIDv7 `partyId`. Not persistent (a guild is) |
| **Host** | The phone that creates the mission and shows the invite QR. Has no extra scoring power |
| **Party mission** | A `ChallengeDefinition` built deterministically from a `PartySpec` + the host's start fix |
| **Invite** | A signed `PartyInvite` (QR) carrying the `PartySpec`, never the full definition |
| **Peer sighting** | A two-sided, signed record that two party phones met, written into **both** players' chains |
| **Party summary** | A signed, monotonic snapshot of one member's progress (`seq`, `chainHead`, a few facts) passed between phones |

## 2. Adaptive quests (ADR-032)

### 2.1 What adapts, and who decides

| Decision | Decided by | How |
|---|---|---|
| Target minutes (30/45/60/90), difficulty tier, number of tasks | **Engine** `adaptQuest()` | Pure ladder over the player's last 14 days of session summaries |
| Which template / activity mix | **Engine**, from an allowed set | Rotation + player's recent modules (variety) |
| Theme and story ("River guardians", "Tree patrol") | **AI** (optional) | Enum `themeId` + free-text narration, non-authoritative |
| Shared party goal size (e.g. litter items) | **Engine** | Per-member quota table × party size |

```
adaptQuest(history: SessionSummary[], progress: Progress, ctx: {dayKey}): QuestSpec
  // QuestSpec gains: tasksCount: 0..3, themeId: ThemeId | null (null until the AI or user picks one)
```

**Ladder (fixed in code, not data):**

| Signal (last 14 days, provisional summaries allowed) | Effect |
|---|---|
| ≥ 3 completed quests at the current tier, none force-stopped | Step **up** one tier (30 → 45 → 60 → 90 min) |
| ≥ 2 force stops, or 2 quests under 50 % of target | Step **down** one tier |
| No quest in 7 days | Return at the lowest tier ("welcome back") |
| Otherwise | Stay |

Rank caps the ladder (E/D players max 45 min, C max 60, B+ 90). Safety stops never count as a "down" signal (§5A.4).
This replaces the fixed level → tier mapping in §3.7 (beginner 30 / mid 45 / pro 90) with a ladder inside the same caps.

### 2.2 The AI's part (`QuestThemeIntent`)

```json
{ "themeId": "tree_patrol", "taskHints": ["water_tree", "photo_proof"], "tone": "playful" }
```

- `themeId`, `taskHints` and `tone` are **enums** from the registry (constrained decoding, same as `ChallengeIntent`).
  No durations, counts, points or places exist in the schema.
- The engine accepts `taskHints` only if they are in the template's allowed task set; otherwise ignores them.
- Narration (intro, per-checkpoint encouragement) is generated **before** going offline or on-device, passed only
  the engine's numbers as facts, with the existing recap guard (no new numbers). Without a model, themes rotate by
  `hash(userId, dayKey)` and narration uses fixed lines.

### 2.3 Server check

The device's history may be provisional, so the server can't recompute the exact ladder step. It checks **bounds**:
the spec must be reachable from the player's rank cap and within ±1 tier of the server's own ladder result.
Otherwise `QUEST_ADAPT_OUT_OF_BOUNDS` (warn): the session counts at the server's tier.

## 3. Offline party (ADR-033)

### 3.1 Flow

```mermaid
sequenceDiagram
  participant H as Host phone
  participant M as Member phone
  Note over H,M: all phones offline (Offline Quest Mode rules, §5A)
  H->>H: adaptQuest + optional AI theme → PartySpec
  H->>H: buildPartyDefinition(spec, hostStartFix) → definitionHash
  H-->>M: QR-1 PartyInvite {partyId, spec, startFix, hostKey, sig}
  M->>M: verify sig, rebuild definition, compare 4-word check code
  Note over H,M: both start their own session, then meet: a two-sided sighting (kind=join)
  loop during play (QR scans at checkpoints and the wrap-up)
    H-->>M: PartySummary set (gossip, signed)
    M-->>H: PartySummary set
  end
  Note over H,M: later, each phone syncs on its own; the server groups by partyId
```

### 3.2 `PartySpec` and `PartyInvite` (in `@trina/contracts`)

```ts
PartySpec = { v: 1, templateId, targetMinutes: 30|45|60|90, levelTier, tasksCount, themeId | null,
              goal: { kind: 'sum_counter' | 'all_checkpoints' | null, ref, perMember: int } | null }

PartyInvite = { partyId, spec: PartySpec, startFix: [lng, lat] /* 6 dp, host's own GPS fix */,
                hostUserId, hostDeviceId, hostPubKey, createdAtMono, notAfter, sig }
```

- Encoded as compact canonical JSON → base45 in a QR (≈ 300–400 bytes, well inside a scannable QR).
- `startFix` is the **host's own GPS fix** (user location, never AI output). It is shared only with people standing next to
  the host who scan the code, the same as showing them where you are.
- `sig = Ed25519(hostDeviceKey, canonicalJson(invite without sig))` reusing the confirmation keys (ADR-026).
- Every phone runs `buildPartyDefinition(spec, startFix)` (engine, pure; generalises `buildQuestDefinition`) and compares
  the hash. The app shows a **4-word check code** from the hash so players can confirm by eye ("tiger · mango · river · seven").

### 3.3 Collaborative missions without shared state

Each player plays **their own session and their own chain**. There is no shared mutable document, so there's nothing to conflict.
"Together" is expressed as:

| Mechanism | Example | Evaluated by |
|---|---|---|
| **Shared goal** | "Party collects 30 litter items" (`sum_counter`, `perMember` × size) | `evaluatePartyGoal(memberSummaries)` (engine, pure) |
| **Shared route** | "Every checkpoint reached by at least one member" (`all_checkpoints`) | same |
| **Co-presence** | "Finish within 10 minutes of each other" (milestone) | sightings (§4) + server `coPresence` |

**Party score rule:** the party goal adds **milestone XP only** (existing milestone engine, `scope: "party"`). It **never changes an
individual challenge score or rank** (consistent with ADR-024). So a colluding party can't inflate anyone's score.

### 3.4 Gossip: how progress spreads with no internet

```
PartySummary = { partyId, sessionId, userId, seq, chainHead, facts: {counters, checkpointsReached, activeS}, monoMs, sig }
mergeSummaries(a: PartySummary[], b: PartySummary[]): PartySummary[]   // engine, pure
```

- **Merge rule:** per `sessionId`, keep the summary with the highest `seq` (a max-register per member; together a CRDT).
  The merge is commutative, associative and idempotent, so phones can exchange in any order, any number of times, through
  any path (A meets B, B meets C → C learns A's progress) and still agree.
- Signed by the member's device key, so a phone relaying a summary can't alter it.
- Transport: **QR** at checkpoints and the wrap-up. One exchange carries all known summaries: about 180 bytes per member
  (64-byte signature included), so up to **≈ 2 KB for 11 members**. Payloads over 800 bytes are split into numbered frames
  ("1/3") shown in a loop; the scanner collects frames in any order. Usually the host gathers everyone at the wrap-up
  (star), but any pair can exchange.
- What the screen shows offline: "Party: 22 / 30 items · Mia 9 · Arif 7 · you 6 (provisional)".

### 3.5 Server side

- Sessions carry `SessionStarted.payload.party = {partyId, inviteHash, hostUserId, role: 'host'|'member'}` (additive, engine v3).
- On sync the server stores `parties(party_id, invite_hash, host_user_id, spec_json, created_from_session)`, checks the invite
  signature against the host's **registered** device key and rebuilds the definition. Mismatch → `PARTY_DEFINITION_MISMATCH` (critical).
- Party goal and party milestones are evaluated **only from verified sessions** (`mode: 'final'`). Members who never sync simply
  don't count; the rest of the party isn't blocked (48 h timeout as today).

## 4. Peer sightings: stronger anti-cheat (ADR-034)

### 4.1 Event

```
PeerSighting = { sightingId, partyId, kind: 'join'|'checkpoint'|'wrapup',
                 peerUserId, peerSessionId, peerSeq, peerChainHead, peerPubKey,
                 myNonce, peerNonce, peerSig, fixAcc }
```

- A QR scan is a **two-sided handshake** (like the confirmation handshake, ADR-026): A shows `{sessionId, seq, chainHead, nonce}`,
  B scans, writes its sighting and shows its own signed answer, A scans back. Both chains now contain the other's chain head.
- No coordinates in the payload. The server uses each player's own `LocationBatch` near that moment.

### 4.2 What it buys (flag, don't accuse)

| Check (server, new "Party" stage after "Claims") | Flag |
|---|---|
| Both sides of a sighting present, signatures valid against registered device keys | `SIGHTING_UNMATCHED` (info → warn after 48 h), `SIGHTING_SIG_INVALID` (critical), `SIGHTING_KEY_UNKNOWN` (critical) |
| Both players' GPS within 75 m + accuracy at the sighting time (each from their own samples) | `SIGHTING_DISTANT` (warn) |
| **Chain entanglement:** `peerChainHead` at `peerSeq` must equal the hash the peer actually synced at that seq | `CHAIN_FORK` (critical): the peer's chain was rewritten after the meeting |
| Sighting times consistent with both chains' `monoMs` and corrected clocks | `SIGHTING_CLOCK` (warn) |
| Party GPS tracks plausible (members claiming co-presence but tracks diverge > 500 m for > 10 min) | `PARTY_TRACK_DIVERGENT` (warn) |

**The new protection.** Today a modified client could edit its own chain *before the first sync* and re-hash it consistently.
Once two phones exchange chain heads, rewriting either chain is detectable from the **other** player's log (`CHAIN_FORK`). The more
people you play with, the harder it is to cheat, without trusting any of them.

**Co-presence offline.** Today `coPresence` is server-only from zone intervals (§4.4). Sightings give the phone a provisional
co-presence answer immediately; the server still makes the final call with sightings **and** zone overlap.

### 4.3 What it doesn't stop (honest list)

- **Two colluding cheaters** can sight each other while apart if one of them relays QR images remotely (e.g. via a photo sent
  earlier). Mitigation: per-scan fresh nonces (replay fails), GPS distance check, and short validity (60 s). Not a proof.
- One person carrying two phones. Unchanged from today (§5 of evidence-validation).

## 5. Transport: QR only (owner decision)

Everything (invite, join, sightings, summaries) goes over **QR codes**, using `qrcode-generator` and `expo-camera`,
which the app already ships for confirmations. No pairing, no permissions beyond the camera, works between any Android and
iPhone, costs no battery while idle, and every scan is itself evidence that two people were together.

| Considered | Why not |
|---|---|
| Bluetooth LE background gossip | Not needed if a quest can be completed with QR alone (owner); iOS limits background BLE; adds a native dependency and battery cost |
| Wi-Fi Direct / hotspot (Xender-style) | For large files; payloads here are KB-sized; fragmented across platforms |
| Google Nearby Connections / Apple Multipeer | Each works on one platform only |

Could be revisited later behind a `PeerTransport` interface without changing events or the merge rule.

## 6. Data and API changes

| Layer | Change |
|---|---|
| `@trina/contracts` | `PartySpec`, `PartyInvite`, `PartyJoin`, `PartySummary`, `QuestThemeIntent`; events `PeerSighting`, `PartySummaryReceived`; `SessionStarted.party`; DSL `goal`. Additive; **engine v3** (server deploys first, ADR-029 rule) |
| `@trina/engine` | `adaptQuest`, `buildPartyDefinition`, `evaluatePartyGoal`, `mergeSummaries`, `checkCode(hash)`, theme table. Pure, property-tested (merge laws, hash determinism across inputs) |
| `@trina/ai` | `questThemeMessages` prompt + eval set (≥ 30 prompts, incl. injections asking for minutes/points); fallback rotation |
| Mobile | Party lobby (host / join), scan + show QR screens (reusing the confirmation QR flow, plus multi-frame QR), party progress card, `PeerSighting` writer, summary store |
| Server | `parties` table, Party validation stage, new flags, party milestones; `GET /v1/parties/:id` (members only) |
| Docs | This file, ADR-032–034, glossary (party, sighting, gossip), STATUS |

No new top-level packages and no new dependencies.

## 7. Plan

| Phase | Scope | Exit criteria |
|---|---|---|
| **7a: pure core** | contracts + engine functions above, golden fixtures | Same `PartySpec` → same hash on Node and Hermes; merge property tests; ladder table tests |
| **7b: QR party** | Mobile lobby, QR invite/join/sightings/summaries (multi-frame), offline party card | 3 phones, internet off, finish a party mission and see the same party total on all; an 11-member summary set scans in ≤ 3 frames |
| **7c: server** | Party stage, flags, party milestones, `CHAIN_FORK` detection | End-to-end test: tampered chain after a sighting → `CHAIN_FORK`; honest party → `verified` |
| **7d: adaptive + AI theme** | `adaptQuest` wired to Daily Quests; theme intent + narration; eval | Eval ≥ 90 % valid; no numbers in any AI output (guard) |

Recommended demo cut for Hacktoberfest: **7a + 7b + the `CHAIN_FORK` part of 7c**: "three phones, no internet, one AI-themed
mission, a shared goal, and tamper detection across phones".

## 8. ADRs (Proposed)

| ADR | Decision |
|---|---|
| **032** | **Adaptive quests:** a fixed engine ladder over measured history picks minutes, tier and task count; the AI may only pick a `themeId`/`taskHints` enum and narrate; the server checks bounds, not equality |
| **033** | **Offline party (QR only, 2–11 logged-in players):** host-created missions shared as a signed parameter invite (QR); every device rebuilds and hash-checks the definition; per-player chains, no shared state; progress spreads by signed max-seq summaries (CRDT gossip); party goals give milestone XP only, never score or rank |
| **034** | **Peer sightings:** two-sided signed QR sightings in both chains cross-link chain heads (`CHAIN_FORK` detection) and give offline co-presence; payloads carry no coordinates |

## 9. Owner decisions (2026-10-12)

| # | Question | Decision |
|---|---|---|
| 1 | Party size | **2–11** players |
| 2 | Who can join | **Any logged-in user** who scans the invite in person; no guild needed. "Logged in" means the phone has logged in at least once, so its device key is registered (needed for signatures and offline verification) |
| 3 | Party goal reward | *Default (not yet confirmed):* milestone XP only, never score or rank |
| 4 | Transport for the demo | **QR only** |
| 5 | Bluetooth | **Not used.** A quest must be completable with QR alone |

**Safety with strangers (from decision 2):** joining needs a physical scan, so players are together anyway. Party screens show only
display names. Nothing about a player's location is shared except the host's start fix, which is where everyone is standing.
A player can leave a party at any time (their own session continues as a solo quest).

## 10. As built (2026-10-12)

Code: `packages/contracts/src/party.ts`, `packages/engine/src/party.ts`, `packages/ai/src/theme.ts`,
`apps/mobile/src/core/party.ts` + `screens/party.tsx`, `apps/server/src/modules/parties/`, Party stage in
`modules/validation/pipeline.ts`, server migration 4, mobile migration 3.

**Changed while building (simpler or safer than §1–8):**
- **No separate join code.** Joining = scan the invite, start, then the ordinary two-sided sighting with `kind: "join"`.
- **Summaries are not events.** `PartySummaryReceived` was dropped: gossip is derived, provisional display data kept in a local
  table; only `PeerSighting` enters the chain.
- **Merge key is the player** (one party session per user), newest `seq` wins, ties by `chainHead`; cut at 11 lowest user ids.
  Verified signatures are cached by full signed content (gossip re-merges the same items often).
- **QR size:** 11 members' summaries ≈ 2.6 KB compact binary → **≤ 4 frames** of 800 chars (not "≤ 3").
- **`SIGHTING_CLOCK` added** after a test showed a 9-minute gap between the two sides of "one" handshake skipped the distance check.
- **Re-validation:** a party session's first validation re-validates its already-validated teammates once (pending → matched,
  late `CHAIN_FORK`); re-runs never cascade.
- **Adaptive server check = rank cap only** (`QUEST_ADAPT_OUT_OF_BOUNDS`, warn), not "±1 tier": players may still pick any
  length up to their cap; the ladder only suggests (Today screen shows why).
- **AI theme runs on the phone only** (device model → rules), never the network: the host is about to go offline.
- `ENGINE_VERSION` stays 2 (scoring unchanged, events additive); `PIPELINE_VERSION` 3.

**Not built yet (honest list):**
- Party goal → milestone XP (§3.3 / owner decision 3 is still a default). Today the verified goal is only shown (`GET /v1/parties/:id`).
- Party sessions don't earn offline-quest XP or count toward the weekly force-stop penalty (the engine treats them as non-quest sessions).
- The phone's provisional co-presence from sightings is not fed into milestones yet; the server still uses zone overlap.
- No real-device or outdoor test: QR scanning in sunlight and multi-frame scanning speed are unverified.
