---
"@b4run/postgres-storage": patch
---

Add a separate Node Agent Protocol runtime installation with coherent schema validation, shared Postgres transactions, independent committed snapshots and fenced native checkpoint writes. Existing runtime handlers remain on their current storage owners pending coordinated cutover.
