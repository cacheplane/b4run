---
"create-b4-app": patch
"@b4run/devkit": patch
---

The basic template now scaffolds a single `/hello` agent route with one typed `greet` tool. It drops the route group, the `[tenant]` segment and `state.ts`, so a new app starts with the smallest working agent.

`basic` is now the default template, so `npm create b4-app@latest my-agent` scaffolds it. The research workspace is still available with `npm create b4-app@latest my-agent -- --template research`.
