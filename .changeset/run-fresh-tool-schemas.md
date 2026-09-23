---
"@b4run/cli": patch
---

`b4 run` and `b4 test` now regenerate `.b4/` tool schemas before executing routes in-process, so a tool added or changed since the last `b4 typegen` is bound with its current input schema instead of a stale or permissive one. A typegen failure is reported on stderr and the route still runs. `b4 typegen` also removes a route's stale `tools.json` once the route has no analyzable tools left.
