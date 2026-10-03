# A route that returns nothing must not make `runs/wait` answer 500

Issue #714. `POST /threads/:id/runs/wait` in the dev runtime
(`packages/cli/src/lib/dev/runtime-fetch-core.ts`, `handleApWaitRequest`) serializes a
completed run's output with `Response.json(result.output, { status: 200 })`. That output is
literally the route's return value, typed `unknown`. `Response.json(undefined)` throws, so a
route whose entry returns nothing (`export const workflow = async () => undefined`) is caught
by the outer handler and answers
`500 {"error":{"kind":"execution_error","message":"Unexpected runtime server failure"}}`,
while the same route over `POST /threads/:id/runs/stream` answers 200 and reports the run as
done. The two endpoints disagree about the same run.

`undefined` is not the only value JSON cannot represent: a route may return a circular object
or a value holding a BigInt, and those reach the same opaque catch-all.

Repair only `packages/cli/src/lib/dev/runtime-fetch-core.ts`. Do not change tests,
configuration, or any other file.

A1: `runs/wait` for a route that returns nothing answers status 200 with the body `null`
(valid JSON, not an empty body).
A2: that response is a success for B4's own `runs/wait` client: `normalizeServerResult`
(`packages/cli/src/lib/runtime/normalize-server-result.ts`) reads it as a `passed` run whose
output is `null`, not as a transport error.
A3: `runs/wait` and `runs/stream` agree about a route that returns nothing: the stream's
terminal frame carries no `error`, and its output is absent or `null`.
A4: falsy outputs are carried unchanged: a route returning `0`, `false` or `""` answers 200
with `0`, `false` or `""`.
A5: an output JSON cannot represent (a circular object, a BigInt) answers 500 with an
`execution_error` whose message says the route's output `could not be serialized` and is not
`Unexpected runtime server failure`.
A6: an ordinary object output is carried unchanged.

Non-goal: no change to `runs/stream`, to other endpoints, or to exported types.
