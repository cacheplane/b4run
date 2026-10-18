---
"@b4run/ag-ui": patch
---

The Angular CopilotKit connector gains `B4ActivityReasoningMessageComponent` for `<copilot-chat>`'s `[reasoningMessageComponent]`. It renders CopilotKit's own reasoning message except for reasoning the turn's `<b4-turn-activity>` already shows (a turn with a tool or subagent step), so the reasoning no longer appears twice. React's `useB4ChatSlots` already behaved this way. The shared check is exported from `@b4run/ag-ui/view` as `reasoningInActivity`.
