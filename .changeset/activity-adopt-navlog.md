---
"@b4run/ag-ui": patch
---

`@b4run/ag-ui/copilotkit` exports `useB4ActivityContext` and its `B4ActivityContextValue` type: the turns, labels, `renderStep` and clock `B4Activity` provides, for host UI outside the chat such as a map or a sheet. It throws outside `B4Activity`, and its error now names `useB4ActivityContext` instead of `useB4ChatSlots`.

A restored thread keeps its media. `eventsFromState` replays a user message that carried an attachment as AG-UI content parts in its `RUN_STARTED` input, and a tool result whose ToolMessage kept parts (`b4_content_parts`) as those parts in `TOOL_CALL_RESULT`, the shape the live stream sends; `reduceTurns` keeps a result's non-text parts on `ToolStep.parts`, live or restored. `@b4run/ag-ui/view` exports `blocksToParts`, the checkpoint-block-to-part mapper the replay uses.
