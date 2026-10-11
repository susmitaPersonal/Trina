# What problem Trina solves

> **One line:** organising real-world group activity is hard, and *proving* it happened is harder.
> Trina turns an idea into a structured outdoor challenge in under a minute, then turns the activity into **verified** participation, impact and wellbeing data.

## 1. The problem

| Who | Pain today | What they do now |
|---|---|---|
| **Friend groups and clubs** | Planning an outdoor activity with rules, a route, teams and fair scoring takes effort, so it doesn't happen | WhatsApp polls that die |
| **NGOs and civic groups** (clean-ups, tree drives) | Can't easily prove who showed up and what was done, which donors and partners ask for | Paper sign-ups, scattered photos, manual reports |
| **Companies (CSR and employee wellness)** | Volunteering and wellness programs need verifiable participation, impact and wellbeing outcomes | Spreadsheets, self-reported numbers, low engagement |
| **Schools and colleges** (eco clubs, NSS, PE) | Outdoor assignments can't be verified; teachers have no time to design them | Honour system |
| **Individuals** | Know they should go outside and move more, but lack a reason, a plan and company | Scrolling instead |

**The gap:** nobody connects *create → play outside → verify → report*. Fitness apps track solo
workouts, and volunteering platforms do sign-ups but no verified on-the-ground evidence.

## 2. How Trina solves it

| Capability | Business value |
|---|---|
| **AI Challenge Agent** | Creating a challenge drops from hours to about a minute. Non-experts (teachers, coordinators) can do it in English, Bengali or Hindi. See [what-ai-does.md](what-ai-does.md) |
| **Local open-weight AI** | No per-request API costs, so a free tier for NGOs and schools is affordable. Private, works in low connectivity, adaptable to local languages |
| **Offline-first** | Works where outdoor activity happens: parks, villages, riverbanks, trails |
| **GPS + photo evidence + deterministic validation** | Trustworthy participation and impact data ("42 volunteers, 3.1 km, 18 trees watered, verified") |
| **Wellness metrics** (steps, calories, mood before/after) | Shows the personal benefit, including "people felt better", which wellness programs care about. See [architecture/wellness.md](../architecture/wellness.md) |
| **Teams and leaderboards** | Engagement and repeat participation |

## 3. Outcomes we can measure

| Outcome | Metric (all computed by code, not AI) |
|---|---|
| People went outside | Verified sessions, minutes outdoors |
| Physical activity | Steps, distance, estimated calories |
| Wellbeing | Average mood change before → after (opt-in, aggregated) |
| Civic impact | Litter bags collected, trees watered, area covered |
| Engagement | Repeat participation, team size, completion rate |

## 4. Business model (post-hackathon)

1. **Free for individuals and friend groups.** Growth and the challenge library.
2. **Organisation plan (main revenue idea).** NGOs, companies and schools get workspaces, bulk participants, **verified impact and wellbeing reports** (PDF/CSV for donors, CSR reporting, school records), dashboards and admin review.
   - *India angle:* CSR spending is mandated for qualifying companies under the Companies Act, with reporting obligations. Verified volunteering data has a concrete buyer.
3. **Sponsored challenges:** local brands, tourism boards or municipalities sponsor clean-up drives or heritage walks.
4. **White-label** for municipalities and campaigns (e.g. a city-wide "Green Sprint" week).

## 5. Honest risks

- **Consumer-only is weak.** Fitness and social retention is hard and incumbents own attention. The **civic, CSR and wellness B2B** angle is more defensible.
- **Verification limits.** Reports must say "verified by automated checks", not "certified".
- **Wellness data is sensitive.** Calories are estimates, mood is self-reported, and neither is medical advice (see [wellness.md](../architecture/wellness.md#5-privacy-and-safety)).
- **Unvalidated demand.** Interview 3–5 NGOs, CSR teams or schools before building paid features.

## 6. Positioning

- **Hackathon pitch:** "Trina (তৃণ, grass): AI-built outdoor challenges that get people off their phones, helping their neighbourhood, and feeling better. Fully offline, with open local AI."
- **Long-term:** "Verified real-world participation, impact and wellbeing for communities and organisations."
