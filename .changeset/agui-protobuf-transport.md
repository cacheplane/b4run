---
"@b4run/ag-ui": patch
"@b4run/cli": patch
---

Serve the AG-UI HTTP+protobuf binding. `POST /agui/:routeId` answers `application/vnd.ag-ui.event+proto` — 4-byte big-endian length-prefixed protobuf frames — whenever the request's `Accept` admits it with a positive quality (named, or through a wildcard such as `*/*`), and `text/event-stream` otherwise; `@ag-ui/client` and CopilotKit name SSE and are unaffected. `GET /agui/:routeId` advertises `transport.httpBinary`, `reasoning: { supported: false }` and `state: { snapshots: false, deltas: false }` plus `persistentState` where B4.run wires the checkpointer (`true` for `agent()` routes, `false` for chain, graph and workflow routes, omitted otherwise).

**Breaking:** `@b4run/ag-ui/sse` no longer exports `encodeAgUiSse(event, accept): string`. Use `encodeAgUiEvent(event, accept): Uint8Array<ArrayBuffer>` for the frames and `agUiContentType(accept): string` for the header; both follow one negotiation rule. Unlike `encodeAgUiSse`, which wrote SSE whatever `accept` said, `encodeAgUiEvent` writes protobuf when `accept` admits it (including `*/*`): set `content-type` from `agUiContentType(accept)`, or call `encodeAgUiEvent(event)` without `accept` to keep SSE unconditionally. The bump is `patch` by the fixed-group 0.x convention. HTTP clients that do not name `text/event-stream` — `curl`, or `fetch` without an `accept` header, both of which send `*/*` — now receive protobuf from `POST /agui/:routeId`; send `accept: text/event-stream` to keep SSE.
