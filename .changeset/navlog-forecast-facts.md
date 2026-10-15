---
"@b4run/devkit": patch
"create-b4-app": patch
---

The navlog template computes its weather facts in code. `computeNavlog` no longer takes winds: it times each leg, takes the winds-aloft forecast for the time that leg is flown, and returns a `forecast` block with each airport's category now and when you are there, the advisories and their relevance, whether the forecasts reach the flight, and the verdict floor. The weather subagent is retired: the coordinator narrates the computed facts, and the Workbench renders them instead of parsing prose.
