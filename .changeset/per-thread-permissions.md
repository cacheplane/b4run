---
"@b4run/permissions": patch
"@b4run/workspace": patch
"@b4run/sqlite-storage": patch
"@b4run/cli": patch
---

A `sandbox.thread` resolver may return `permissions`: that thread's permission gates then use its own allow-list in place of the app's, keep the app's mode and every denial (the app's and the thread's), and save an "Always" decision to the thread's record in the workspace installation, never to `.b4/permissions.json` or a configured `permissions.store`. A subagent runs under its parent thread's permissions. `createThreadPermissionsStore` builds such a store over any `PermissionsStore` and passes the store conformance suite. Empty permission patterns are refused in a thread's lists because they would allow every candidate.
