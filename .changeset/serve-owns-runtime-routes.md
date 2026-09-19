---
"@b4run/cli": minor
---

Add `serve()`, a Node entry point that answers B4.run's own routes and the application's from one listener. An app that serves its own HTTP surfaces beside the agent had to hand-write that split: mount the runtime for the paths it believes B4.run owns, send the rest to its handler, log the address, and unwind both in the right order on SIGINT. `serve({ appRoot, middleware, port, fallback })` owns all of it; an app that serves nothing of its own omits `fallback` and the runtime answers every path.

Which paths the runtime owns is B4.run's fact, not the application's, so it is now stated once: `/healthz`, `/readyz`, `/agui`, `/threads`, and `/memory` — with any deeper path under each — live in one definition that both `serve` and the Vercel build target's route table (`VERCEL_RUNTIME_ROUTE_SRC`, unchanged in value) are built from. A hand-written prefix list goes stale the moment the runtime grows a surface: the new endpoint reaches the application handler and answers 404, or, behind a single-page fallback, an HTML document with a 200.

Shutdown runs in the only order that terminates — stop accepting, close the runtime so in-flight runs abort and streams finish, then drop the connections still held open. `installSignalHandlers` defaults to `true` here (unlike `serveRuntime`), because this is an entry point rather than a component of a larger host.

Closes #737
