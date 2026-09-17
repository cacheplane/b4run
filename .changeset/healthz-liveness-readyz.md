---
"@b4run/cli": patch
---

`GET /healthz` is now a pure liveness probe: it never builds per-request stores, so a `vercel` or `hono` deployment with `DATABASE_URL` unset or its database unreachable answers 200 instead of 500. Dependency readiness moved to the new `GET /readyz`, which probes the threads, checkpointer and permissions stores and answers 503 naming each failing dependency, with connection-string credentials redacted (#688).
