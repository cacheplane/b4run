---
"@b4run/core": patch
"@b4run/cli": patch
---

A `readFile`, `writeFile`, `editFile` or `listDir` call that parks for approval outside the workspace now names the tool call it gates: the path gate's permission interrupt carries `toolCallId` like the command, tool and memory gates already did, so an AG-UI client attaches the approval to the call's step instead of showing it unanchored. `createWorkspaceFs` accepts an optional `toolCallId`, and the `ctx.fs` handed to a route's own tools carries the call's id.
