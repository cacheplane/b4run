---
"@b4run/ag-ui": patch
"@b4run/cli": patch
"@b4run/sdk": patch
---

Restore a CopilotKit chat from B4's storage. `GET /threads/:thread_id/events` replays a thread as the AG-UI events its live runs carried (`eventsFromState` in `@b4run/ag-ui/view`), behind the same gate as `/turns` (new `thread.events` operation). `@b4run/ag-ui/copilotkit-runtime` adds `B4AgentRunner`, a CopilotKit runtime runner whose `connect` replays it, so a reload, a restart or another instance restores the chat, its activity and a parked approval.
