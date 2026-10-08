---
"@b4run/ag-ui": patch
"@b4run/langchain": patch
"@b4run/cli": patch
---

Every `TOOL_CALL_START` B4.run sends now carries `parentMessageId`: the id of the model message that announced the call — the id that message's `TEXT_MESSAGE_*` events use when it streamed text, a fresh one when it only called tools, the subagent's own message for a subagent's call. A chat host that builds its message list from AG-UI events now gets an assistant message during a tool-only phase, and keeps a model message's text and calls together. `eventsFromState` (and so `GET /threads/:id/events`) files replayed calls the same way, under the checkpointed AIMessage's id. The langchain adapter's `tool_call` and `tool_call_args` chunks carry the model invocation as `data.messageId`, and the CLI's `tool_call` stream chunk carries it as `messageId`. `mergeTurnMessages` (and so `useB4ChatSlots`) still renders one activity per turn: the turn's first assistant message with tool calls holds every call of the turn, after its text when it has some.

`turnForMessage` and `<b4-message-activity [messages]>` accept messages that list their tool calls as `toolCallIds: string[]` as well as AG-UI's `toolCalls: { id }[]` (`toolCallIds` is read when `toolCalls` is absent); `@b4run/ag-ui/view` exports `toolCallIdsOf`.

`@b4run/ag-ui/view` exports `toResumeEntries(decisions, interrupts)`: the AG-UI `resume` entries for approval decisions, `once`/`always` resolved with that payload, `deny` cancelled, each interrupt's grant at `metadata.grant`. It returns `{ ok: false, reason: "undecided" }` until every parked interrupt is decided, since B4.run resumes only when all of them are answered. `B4ApprovalDecision` (`@b4run/ag-ui/angular/events`) is now an alias of the view's `InterruptDecision`.
