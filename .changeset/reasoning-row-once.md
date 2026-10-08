---
"@b4run/ag-ui": patch
---

`useB4ChatSlots` shows a turn's reasoning once. CopilotKit renders each reasoning message on its own row, and `TurnActivity` shows the same span as a step, so a turn that called tools read "Thought for 40 seconds" above "Thought for 40s". The slots now include a `reasoningMessage` that renders nothing for reasoning a turn's activity already shows; a turn that only reasoned and answered has no activity row and keeps CopilotKit's.
