---
"@b4run/devkit": patch
---

The navlog scaffold's `computeNavlog` accepts a wind with no forecast temperature (`tempC: null`), which is what `getWindsAloft` returns at 3,000 ft. The planner's first call had failed schema validation on every route flown low enough to use that level.
