---
"@b4run/ag-ui": patch
"@b4run/devkit": patch
---

`@b4run/ag-ui/react/copilotkit` exports `useB4ActivityContext` and its `B4ActivityContextValue` type: the turns, labels, `renderStep` and clock `B4Activity` provides, for host UI outside the chat such as a map or a sheet. It throws outside `B4Activity`, and its error now names `useB4ActivityContext` instead of `useB4ChatSlots`.

A restored thread keeps its media. `eventsFromState` replays a user message that carried an attachment as AG-UI content parts in its `RUN_STARTED` input, and a tool result whose ToolMessage kept parts (`b4_content_parts`) as those parts in `TOOL_CALL_RESULT`, the shape the live stream sends; `reduceTurns` keeps a result's non-text parts on `ToolStep.parts`, live or restored. `@b4run/ag-ui/view` exports `blocksToParts`, the checkpoint-block-to-part mapper the replay uses.

The navlog template's web client chats through CopilotKit's stock `<CopilotChat>` inside `B4Activity`, with `computeNavlog` and `renderChart` step views, the kit's `ApprovalCard` for approvals, and image attachments through the chat's own input. It restores a thread through `createB4AgentRunner(InMemoryAgentRunner, { url, fetch })` in its CopilotKit route, so its `/api/b4` proxy now forwards only the three memory-candidate routes, and its map, sheet and weather strip read the activity turns with `useB4ActivityContext`. The custom transcript, composer, tool-call card, permission components and checkpoint hydrator are gone from the template.

`@b4run/ag-ui/copilotkit-runtime` no longer imports `@copilotkit/runtime`. The runner is built with `createB4AgentRunner(InMemoryAgentRunner, { url, fetch })`, where the CopilotKit runtime route passes its own `InMemoryAgentRunner` class from `@copilotkit/runtime/v2`; the `B4AgentRunner` class export is gone. The runner extends the copy of CopilotKit the route resolves, so an npm workspace that hoists `@b4run/ag-ui` to the root while installing `@copilotkit/runtime` only under the web package no longer fails with `Cannot find package '@copilotkit/runtime'`. `@copilotkit/runtime` is no longer a peer dependency of `@b4run/ag-ui`, and `rxjs` (`^7.8.1`) is now a regular dependency instead of an optional peer.
