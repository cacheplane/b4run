---
"@b4run/sdk": patch
"@b4run/cli": patch
"@b4run/sqlite-storage": patch
"@b4run/postgres-storage": patch
---

Assign durable journal coordinates in storage and stamp each event with its current Run and logical turn authority. Preserve namespace components and historical journal reads, and roll back journal write failures even when a transaction callback catches the error.
