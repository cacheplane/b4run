---
"@b4run/devkit": patch
---

The navlog template's `getWindsAloft` takes the time the leg is flown (`validAtUtc`: the departure or the leg's ETA) instead of forecast hours, reads the 6-, 12- and 24-hour FB products and uses the one whose FOR USE window contains that time, returning the window as UTC instants. When no published product covers the time yet it says so (`covered: false` with a note), so the brief marks the winds preliminary. The weather subagent no longer works out forecast hours itself.
