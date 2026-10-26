---
"@b4run/sdk": patch
"@b4run/postgres-storage": patch
"@b4run/cli": patch
---

Coordinate concurrent runs and browser-tool continuations across generated Postgres-backed runtime instances. Add request-owned run admission, expiring owner tokens and transactional storage fencing, reject competing work with a retryable conflict, and release ownership only after execution cleanup before exposing successful terminal events.
