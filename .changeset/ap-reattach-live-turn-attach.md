---
"@b4run/cli": patch
"@b4run/sdk": patch
---

Add `GET /threads/{id}/runs/stream` — reattach to a running turn. A disconnected
client rejoins by attaching to this read-only GET mirror of the POST stream: one
`event: state` snapshot (channel values, the turn's coalesced frames so far, and
parked interrupts) followed by the live tail, or an immediate durable snapshot +
`done` when no live turn exists in this process. It requires thread-access `read` plus middleware approval for the selected
producer and the recorded parked, last-run, and anchor routes. The selected
turn stays fixed across asynchronous authorization. Backed by a bounded in-memory `LiveTurnHub`; the durable
path works across restarts, replicas, and serverless. Being a GET with no body,
it is the first Agent Protocol stream a stock `EventSource` can consume.

`@b4run/sdk` gains one additive `ThreadOperation` member, `thread.attach`, for
the new endpoint. A thread-access policy that switches exhaustively over
`ThreadOperation` should add a `thread.attach` arm; a `fallback` handler already
covers it.

Canceling or aborting an attach releases its viewer slot and heartbeat without
stopping the producer. Slow viewers remain bounded and are detached on overflow.
The durable retry hint precedes `done`, so clients can stop reading at the terminal frame.

Bind checkpoint ownership to the exact checkpoint ID at the saver write boundary,
retaining verified ancestor routes and overwriting any upstream ownership claim.
Attach authorizes that provenance instead of inferring checkpoint ownership from
mutable thread metadata. Legacy or unknown checkpoint ancestry fails closed with
`thread_route_unknown`; a fresh thread establishes verified provenance.
