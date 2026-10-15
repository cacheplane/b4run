---
"@b4run/devkit": patch
"create-b4-app": patch
---

The navlog template's weather rules (forecast coverage, flight category at a time, advisory relevance and the verdict floor) move into tested pure functions under `server/src/lib/forecast/`, with a winds-aloft station table built by `server/scripts/build-winds-stations.mjs`. The weather tools behave as before.
