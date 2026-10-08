---
"@b4run/sdk": patch
"@b4run/cli": patch
"@b4run/core": patch
"@b4run/langchain": patch
"@b4run/testing": patch
"@b4run/devkit": patch
---

An app can now declare one place that resolves who is calling: `src/auth.ts` default-exports `defineAuth({ authenticate })`. B4.run calls `authenticate` once per request, before middleware and the thread-access policy, and passes the result to middleware and the thread-access policy as `req.principal` and to every tool as `ctx.principal`. A principal is any object with a string `id`. `undefined` makes the request anonymous, `reject(...)` answers it before any endpoint runs, and a throw or malformed result fails it with a 500.

`b4 typegen` declares the type `authenticate` resolves to on `B4Register`, so `ctx.principal` is typed. The node and web build targets carry `src/auth.ts` in their build, and the `langsmith` target refuses an app that has one. An auth file that does not default-export `defineAuth` fails the boot with `B4_E3005`. The harness takes a `principal` option, and `createAgentProtocolInjector` takes `auth`.

**Breaking:** `ThreadAccessRequest.headers` is removed. A thread-access policy that read identity from headers must move that read into `src/auth.ts` and use `req.principal`. The `basic` and `navlog` templates are migrated, and the `navlog` template no longer ships `src/middleware.ts`.
