---
"@b4run/sdk": patch
"@b4run/cli": patch
"@b4run/ag-ui": patch
---

Add an `after` hook to the middleware lifecycle definition. `defineMiddleware({ handle, after })` runs `after` once per AG-UI run with the agent's final assistant message and the context `handle` allowed, before the client sees the message: return nothing to keep it, `{ finalMessage }` to replace it, or `reject(...)` to end the run with a `RUN_ERROR` (code `middleware_rejected`). With the hook defined the final assistant message is buffered and delivered whole before `RUN_FINISHED`; text before a tool call still streams live, and an app without the hook emits exactly the events it did before. `@b4run/ag-ui`'s `toAguiEvents` now forwards a string `code` from an upstream error onto `RUN_ERROR`.
