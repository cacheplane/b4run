---
"@b4run/cli": patch
"@b4run/langchain": patch
---

Tool-output offloading now works for sandboxed routes and fails closed. Under a managed sandbox workspace, offloaded outputs are written through the sandbox's filesystem into its own root (`/workspace/tool-outputs/`), so the stub's `tool-outputs/…` path is readable with `readFile`; before, the write targeted the host `workspace/` path, failed at the sandbox's path jail, and the full oversized result went inline into the model context. If an offload write fails for any reason, `offloadToolOutput` now returns a bounded stub (the preview lines, capped at 8,192 chars, plus the sanitized error) instead of the full content, and the runtime warns once per distinct cause. Stub previews are also capped at 8,192 chars, and a tool's string result is previewed by its real lines.
