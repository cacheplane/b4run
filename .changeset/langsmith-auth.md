---
"@b4run/cli": patch
"@b4run/langchain": patch
---

`b4 build --target langsmith` compiles an app's `src/auth.ts` instead of refusing it. The build writes `.b4/build/auth.ts`, a LangGraph `Auth` that runs the app's `authenticate`, and sets `langgraph.json` `auth` with `disable_studio_auth: true`. `reject` becomes its status, and an anonymous request is a 401, since LangGraph has no anonymous user. An `ownedThreads` thread policy compiles to owner-stamp metadata filters; any other policy is still refused. Tools read the caller as `ctx.principal` from LangGraph's auth user.

The build refuses an auth file that compares a secret from an `x-*` header, which LangGraph copies into stored run config. It also refuses memory scoped by `user`, `tenant` or `agent`, and warns that `src/middleware.ts` is not deployed. `createLangSmithAuth` is exported from `@b4run/cli/runtime`.
