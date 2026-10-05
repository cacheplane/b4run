---
"@b4run/devkit": patch
"create-b4-app": patch
---

The `navlog` scaffold is now a Cessna 172N VFR flight planner: live aviationweather.gov tools (no key), a POH-grounded `computeNavlog` tool, `weather` and `performance` subagents, and `fileFlightPlan` behind per-call approval. The research corpus, `searchCorpus`, the `researcher` subagent, `runBash` and the Docker sandbox seam are gone from the scaffold. `npm test` runs keyless unit tests of the math and parsers; `npm run eval` replays scripted cases without a key.
