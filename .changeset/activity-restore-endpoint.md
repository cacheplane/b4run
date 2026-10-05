---
"@b4run/cli": patch
"@b4run/sdk": patch
---

**Breaking:** `GET /threads/:thread_id/state` reports `created_at` as the checkpoint's time instead of the request time. New `GET /threads/:thread_id/turns` rebuilds a thread's activity turns (`@b4run/ag-ui/view`'s `TurnsView`) from its checkpoints, parked interrupts embedded, gated like `/pending_interrupts`; a denied call restores as a `denied` step, not a failed one. `ThreadOperation` gains `thread.turns`. Threads from releases before the `b4_step`/`b4:turn` stamps do not restore.
