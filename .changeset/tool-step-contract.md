---
"@b4run/sdk": patch
"@b4run/ag-ui": patch
"@b4run/langchain": patch
---

`b4.step` is now a versioned contract owned by `@b4run/sdk`. `B4ToolStep` (`v: 1`) is what clients read and what other producers should write. `readToolStep` reads the carriers (tool-call metadata, the `b4.step` `CUSTOM` event and the persisted `b4_step`) and normalizes the legacy shapes B4.run's own runtime still emits and persists; the runtime's emitters move to v1 in a later release. `readToolStep`, `readToolStepUpdate`, `mergeToolStep` and `settleOpenSteps` read and merge it, `B4_TOOL_STEP_JSON_SCHEMA` and `B4_ANSWER_JSON_SCHEMA` are also published as `@b4run/sdk/tool-step.schema.json` and `@b4run/sdk/answer.schema.json`, and `@b4run/sdk/testing` gains `TOOL_STEP_FIXTURES` and `foldToolStepEvents` so a producer and a client test against one corpus. The event name has a single source, `B4_STEP_EVENT_NAME`.

`@b4run/ag-ui/view` builds its steps from the contract: it reads `b4.step` metadata as well as the event, and a step can now be `cancelled`. Behavior changes:

- A successful run no longer fails the calls it left open; they stay as they are. A restored thread whose turn ended without a call's result still shows that call as failed.
- A cancelled run settles its open steps as `cancelled` rather than `failed`. An interrupt cancels the open calls it doesn't park, and keeps open the ones named in `interrupts[].toolCallId` and `outcome.pendingToolCallIds`. A re-presented `TOOL_CALL_START` reopens a cancelled step.
- A `TOOL_CALL_RESULT` with no step of its own completes a running step and clears its running label. A result with a top-level `error` fails the step, even after a `completed` step.
- A settle drops the running label and sources unless it restates them, and a late `running` step changes nothing on a settled one.
- `StepStatus` gains `cancelled`. That is a type-level change: a `switch` over `StepStatus` checked for exhaustiveness needs a `cancelled` case.

`readToolStep` and `readToolStepUpdate` return `undefined` for a `v` other than 1; a value without `v` still reads as legacy.

The deprecated `readStepEvent` now drops an empty-string label. `PersistedStep`, `readPersistedStep`, `B4StepEventValue`, `B4StepStatus` and `B4_STEP_STATUSES` remain, marked deprecated.
