---
"@b4run/sdk": patch
"@b4run/core": patch
"@b4run/cli": patch
"@b4run/ag-ui": patch
"@b4run/devkit": patch
---

A route can require approval on every call of a tool, with no standing approval possible: write the `tools.approve` entry as `{ tool: "fileFlightPlan", allowAlways: false }` instead of the bare name (bare names keep today's behavior, and the two forms mix in one list). For such a tool every call prompts in interactive mode even when the permission store holds an allow rule for it, the interrupt envelope carries `allowAlways: false`, and the AG-UI interrupt advertises `responseSchema.enum: ["once", "deny"]`, so the activity kit's approval card offers only Allow once and Deny. A client that answers `always` anyway gets `once`: the call runs, nothing is persisted, and the step records `once`. Bypass mode still allows and a deny rule still denies; non-interactive mode and contexts without interrupts fail closed, an allow rule notwithstanding, so a headless run of such a tool needs bypass. `@b4run/sdk` exports `ApproveEntry`, `NormalizedApproveEntry` and `normalizeApproveEntries`; `b4 check` validates the object form (unknown names, malformed entries, overlap with `constrain`), and the reserved `task` check covers it. The navlog example and scaffold approve `fileFlightPlan` this way, so on a shared permission store one visitor can no longer approve filing for everyone.
