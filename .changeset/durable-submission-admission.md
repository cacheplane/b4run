---
"@b4run/sdk": patch
"@b4run/core": patch
"@b4run/cli": patch
"@b4run/sqlite-storage": patch
"@b4run/postgres-storage": patch
---

Add shared durable Run admission and indexed submission reconciliation with current authorization, atomic acceptance, and original-default retry recovery. Add one-time runtime storage factory registration for SQLite and Node Postgres. Runtime execution and standard HTTP binding activation remain staged for the shared ExecutionHost cutover.
