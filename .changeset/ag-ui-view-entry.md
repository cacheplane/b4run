---
"@b4run/ag-ui": patch
---

New `@b4run/ag-ui/view` entry: the framework-free client half. `reduceTurns` folds AG-UI events into a thread's turns — tool steps with their `b4.step` labels, the plan, reasoning, nested subagent turns, and approvals attached to the calls they gate — and `stepLabel`/`groupSteps` turn steps into sentences. `reduceSubagentRuns` moved here (still re-exported from `./react`).
