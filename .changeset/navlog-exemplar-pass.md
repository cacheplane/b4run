---
"@b4run/devkit": patch
"create-b4-app": patch
---

A readability pass on the navlog template, the example new apps start from.
- **READMEs:** they now describe the current layout, request flow, structured answer and tests. AGENTS.md gains a navlog section.
- **Memory schema:** its text describes navlog's facts.
- **Removed:** the unused `state.ts`.
- **Map:** the marker and label helpers move out of `RouteMap`, and the label priorities are named.
- **`ThreadWorkbench`:** now has its own file.
- **Comments and props:**
  - Comments describe the code as it is.
  - Props that both said "brief" now say `weatherBrief` and `planningAnswer`.
