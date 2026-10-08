---
"@b4run/devkit": patch
---

The navlog scaffold resolves the departure time once with a new `resolveDeparture` tool, and the planner hands the same UTC instant and hours-ahead figure to the weather subagent and to `computeNavlog`. The weather subagent no longer works out "tomorrow" itself, which had put a departure 15 hours out at 39 and marked a covered brief preliminary.
