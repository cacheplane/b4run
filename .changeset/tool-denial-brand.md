---
"@b4run/sdk": patch
"@b4run/core": patch
"@b4run/langchain": patch
---

A tool call blocked by `tools.approve` or `tools.constrain` now returns its denial reason branded (`toolDenial(reason)` / `isToolDenial` / `TOOL_DENIAL` from `@b4run/sdk`) instead of a bare string. The model receives exactly the same text as before. The runtime can now tell a denial from a successful result, so a tool's `display.done` and `display.sources` are no longer asked to describe a denial as if it were output: the call's `b4.step` `completed` event carries the icon only, with no label or sources.
