---
"@b4run/sdk": patch
"@b4run/langchain": patch
"@b4run/cli": patch
---

Server tool calls are recorded in the tool-call record only when a route is listed in `server.agui.clientTools` or `server.agui.clientToolStore` is set. A default `.b4/client-tool-calls.sqlite` left over after the opt-in was removed is still opened so calls parked back then can be closed, but it no longer records server calls, and boot logs one warning naming it. `ClientToolRecorder.issue` and `settle` are optional: absent on runs that do not record server calls.

The `task` call that launches a subagent is now recorded as a server row like any other tool: issued before the subagent runs, open while it is parked, settled when it returns, fails or is refused. A `role: "tool"` message carrying a task id is dropped as a server row. The issue/settle discipline lives in one `@b4run/langchain` helper used by the tool converter and the subagent bridge.
