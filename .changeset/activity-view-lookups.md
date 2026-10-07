---
"@b4run/ag-ui": patch
---

`@b4run/ag-ui/view` exports the lookups a chat connector needs between a transcript, its turns and its parked interrupts, so every connector shares one implementation: `turnForToolCalls` (moved from the CopilotKit connector), `turnForMessage` (the turn an assistant message belongs to, by its run's tool calls, else by position from the end of the thread, and whether it is that turn's first assistant message), `approvalFromInterrupt`, `approvalPrompt` and `approvalLabel` (an approval card's view and its "{agent} wants to {label}", moved from `B4Activity`), and `pendingApprovals` (the cards an awaiting thread shows, read from its turns alone), with the `TranscriptMessage`, `MessageTurn`, `ApprovalPrompt` and `PendingApproval` types. `B4Activity` and `useB4ChatSlots` now use them; their behavior is unchanged.
