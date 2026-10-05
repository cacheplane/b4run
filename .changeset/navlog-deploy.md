---
"@b4run/devkit": patch
"create-b4-app": patch
---

The `navlog` scaffold ships a visitor principal (`src/auth.ts`), route middleware and a thread-access policy that are inert in development and turn on behind a proxy that sets `B4_INTERNAL_TOKEN`, a memory backend switch to Postgres + pgvector on `DATABASE_URL`, and proxy guards in the Workbench (origin allowlist, per-visitor cookie, per-visitor and per-IP rate limit, token injection, owner-only memory approval). The scaffold gains three dependencies, `@b4run/memory-pgvector` (server) and `@upstash/ratelimit` and `@upstash/redis` (web), and now builds the `node` target only, since a thread-access policy cannot ship to LangSmith. The example repository adds a Railway Dockerfile and a Vercel project config for the live demo.
