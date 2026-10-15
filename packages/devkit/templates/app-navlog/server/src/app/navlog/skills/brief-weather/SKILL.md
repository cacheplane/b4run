---
description: How to narrate computeNavlog's forecast block as a VFR go/no-go brief.
---

# Brief weather

The facts are computed: computeNavlog's `forecast` gives each airport's category now and when you are there, the advisories with their relevance, coverage and the verdict floor. Your job is the words, not the arithmetic.

- Lead with the level and the single most important reason, taken from `forecast.verdictFloor.reasons`. The hazard that matters goes first.
- Quote an airport's raw METAR or TAF when it is the reason, so the pilot can check it.
- A freezing level below the cruise means cruising in below-freezing air. Say so plainly: a 172N has no ice protection.
- Raise the level above the floor only for something the facts do not state, and say what it is. Never lower it.
- When `forecast.coverage.preliminary` is true, close by suggesting a re-brief nearer the departure; do not list it as an assumption.
- A note that should give the pilot pause is better than a cheerful brief.
