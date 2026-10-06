---
"@b4run/devkit": patch
---

The navlog scaffold's `computeNavlog` and `fileFlightPlan` accept a departure with the day the pilot named, `"tomorrow 1500Z"` or `"1500Z tomorrow"` (and `"today …"`). "Tomorrow" is the first such time at least 12 hours ahead, so a pilot asking in the morning or the evening of any US time zone gets their tomorrow; a bare `1500Z` is still its next occurrence. The planner passes the day through to the navlog and the weather brief instead of dropping it, which had put a "tomorrow" flight on today's date.
