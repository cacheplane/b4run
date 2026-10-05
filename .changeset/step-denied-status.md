---
"@b4run/ag-ui": patch
"@b4run/langchain": patch
---

A tool call blocked by `tools.approve` or `tools.constrain` now settles its `b4.step` with `status: "denied"` (icon only) instead of `completed`. `B4_STEP_STATUSES` and `B4StepStatus` gain `denied`; `reduceTurns` settles the step as `denied`, drops the running label and sources it does not replace, and never counts it toward `turn.failed`; `stepLabel` reads it as "Denied x" (an app's `done` override never runs for it); the React `Step` renders `data-state="denied"` with a "· denied" tail and the tool's own icon.
