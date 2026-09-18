---
"@b4run/cli": minor
"@b4run/core": minor
"@b4run/sdk": minor
---

Validate the AG-UI run envelope in the runtime, and close client-supplied `tools` and `forwardedProps` by default.

`POST /agui/:routeId` used to accept whatever AG-UI's schema would parse and hand it on: `threadId: ""`, a whitespace-only `runId`, a megabyte-long id and `state: "nope"` all reached route code, so every app that cared re-checked B4.run's own wire format by hand — and had to re-check it again each time the protocol grew a field. Those four are now structurally validated before anything else runs, and a body that parses but is not one B4.run will act on is a `422` under the new `B4_E5401`, with a machine-readable `error.details.code` (`invalid_envelope`, `invalid_thread_id`, `invalid_run_id`, `invalid_state`).

**Breaking for apps that pass client tools.** `tools` and `forwardedProps` are not an app's inputs — they are the caller's attempt to add to what the *route* decided, and a client that sends `tools: [...]` on a route whose tool set the server chose is asking for authority it was not given. A non-empty `tools` or `forwardedProps` is now REJECTED (`422`, `client_tools_not_allowed` / `forwarded_props_not_allowed`) unless the route names itself in the new `server.agui` config, because silently ignoring a field is indistinguishable from honoring it and a client cannot tell which happened. An empty `tools: []` / `forwardedProps: {}` — what an AG-UI client sends when it has nothing to add — is unaffected, so an ordinary client sees no change. A route that genuinely wants them opts in:

```ts
server: { agui: { clientTools: ["/chat"], clientForwardedProps: ["/chat"] } }
```

This turns a silent narrowing into a loud one. `fromRunAgentInput` has never interpreted client `tools`, so a client that sent frontend tools — a CopilotKit frontend action, for instance — already got a run that ignored them; it now gets a `422` instead, which is the point.

The check runs before route middleware and before the thread-access policy: it needs no I/O, takes no resume claim and reads no thread row, so no app middleware is handed an envelope the runtime has already refused, and no policy is asked to authorize — or create a row for — a request that is about to be rejected. `resume` is deliberately not decided there, because whether a turn genuinely resumes depends on what is parked in the checkpointer, which is only readable once the policy has authorized this caller for that thread; `resolvePendingResume` still rejects a resume that matches no pending interrupt (`409`, `stale_interrupt`) at the point where the answer is known.

Closes #735.
