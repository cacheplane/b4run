---
"@b4run/ag-ui": patch
---

**Breaking:** `b4ActivityRenderers` and `b4PlanActivityRenderer` moved from `@b4run/ag-ui/react` to the new `@b4run/ag-ui/react/copilotkit` entry; `./react` no longer imports CopilotKit.

`@b4run/ag-ui/react` is now the React activity kit: `TurnActivity`, `Step`, `StepGroup`, `StepDetail`, `PlanStep`, `ReasoningStep`, `SubagentStep`, `ApprovalCard`, `SourceChips` and the building blocks, rendering one turn in plain language from `@b4run/ag-ui/view`. `@b4run/ag-ui/react/copilotkit` drives a stock `<CopilotChat>` with it (`B4Activity`, `useB4ChatSlots`, `useB4Turns`). The stylesheet moves into `@layer b4-activity` with the design tokens; dark mode follows the host (`.dark`, `[data-theme="dark"]`, `data-b4-theme`). The legacy cards stay, deprecated.
