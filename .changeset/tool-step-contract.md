---
"@b4run/sdk": patch
"@b4run/ag-ui": patch
"@b4run/langchain": patch
---

`b4.step` is now a versioned contract owned by `@b4run/sdk`. `B4ToolStep` (`v: 1`) is what clients read and what other producers should write. `readToolStep` reads the carriers (tool-call metadata, the `b4.step` `CUSTOM` event and the persisted `b4_step`) and normalizes the legacy shapes B4.run's own runtime still emits and persists; the runtime's emitters move to v1 in a later release. `readToolStep`, `readToolStepUpdate`, `mergeToolStep` and `settleOpenSteps` read and merge it, `B4_TOOL_STEP_JSON_SCHEMA` is also published as `@b4run/sdk/tool-step.schema.json`, and `@b4run/sdk/testing` gains `TOOL_STEP_FIXTURES` and `foldToolStepEvents` so a producer and a client test against one corpus. The event name has a single source, `B4_STEP_EVENT_NAME`.

`@b4run/ag-ui/view` builds its steps from the contract: it reads `b4.step` metadata as well as the event, and a step can now be `cancelled`. A cancelled or interrupted run settles its open steps as `cancelled` rather than `failed`; an interrupt keeps open the calls it names in `interrupts[].toolCallId`. A re-presented `TOOL_CALL_START` reopens a cancelled step. A `TOOL_CALL_RESULT` with no step of its own completes a running step.

The deprecated `readStepEvent` now drops an empty-string label. `PersistedStep`, `readPersistedStep` and `B4StepEventValue` remain, marked deprecated.
