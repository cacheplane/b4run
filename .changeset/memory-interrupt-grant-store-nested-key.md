---
"@b4run/sdk": patch
---

`createMemoryInterruptGrantStore` now keys grants by thread and then by interrupt instead of a flat joined `threadId`/`interruptId` string, so two distinct pairs whose ids contain the separator can no longer read, consume, or void each other's grant. The SQLite and Postgres stores were not affected.
