---
"@b4run/ag-ui": patch
---

`@b4run/ag-ui/copilotkit` exports `useB4ActivityContext` and its `B4ActivityContextValue` type: the turns, labels, `renderStep` and clock `B4Activity` provides, for host UI outside the chat such as a map or a sheet. It throws outside `B4Activity`, and its error now names `useB4ActivityContext` instead of `useB4ChatSlots`.
