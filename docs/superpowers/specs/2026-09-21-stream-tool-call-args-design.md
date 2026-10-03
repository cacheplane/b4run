# Stream tool-call arguments incrementally

## Problem and scope

A root tool call reaches the AG-UI wire as three frames emitted together at
the end of the model turn: `TOOL_CALL_START`, one `TOOL_CALL_ARGS` whose delta
is `JSON.stringify(args)`, and `TOOL_CALL_END`. Clients that render from a
tool call's arguments cannot paint until the whole argument object exists,
although the provider streams the argument JSON as it is generated and
LangChain surfaces those fragments on each `on_chat_model_stream` chunk as
`tool_call_chunks`.

Emit the arguments as they are generated, as one or more `TOOL_CALL_ARGS`
deltas, so that their concatenation is byte-identical to the single delta sent
today. Display only: tool execution, interrupt identity, the orchestration
ledger and every non-streaming provider are unchanged.

## Design

### Adapter (`@b4run/langchain`)

`classifyStreamEvent` gains a `tool_call_args` chunk, `data: { id, name,
delta }`, emitted from a root `on_chat_model_stream` event whose chunk carries
`tool_call_chunks` with string `args` fragments. Fragments are correlated by
`(model run_id, index)` in a per-run table on the root projection state.
The provider sends `id` and `name` on the first fragment only; later fragments
carry `index` alone. A fragment whose index has neither id nor name yet is
buffered and released once both are known, so nothing is lost. Emission for an
index starts only when the id is not already announced and the name is not one
of the two orchestration tools (`writeTodos`, `task`); those two stay on the
single-delta path and their fragments are dropped. Subagent (child) model runs
never stream.

At `on_chat_model_end` for that run, each streamed index is flushed first, then
the existing `tool_call` chunk is announced exactly as today, and the run's
table is cleared. The announce path and its `announcedToolCallIds` guard are
untouched: the resume replay (a tool node re-executed with no model turn) has
no `on_chat_model_stream` events and therefore no deltas, and the `tool_call`
announce remains the only identity a call is ever given. Streaming introduces
no new id: every delta carries the same logical tool-call id the announce uses.

### Byte identity: the canonical JSON transcoder

Providers stream the raw JSON text the model wrote; today's delta is
`JSON.stringify(JSON.parse(rawText))`. The two differ in whitespace, escape
form (`é` vs `é`), number form (`1.0` vs `1`), and, for two rare shapes,
member order (array-index-like keys sort first; duplicate keys keep the first
position with the last value). A new module, `canonical-json-stream.ts`,
re-serializes the raw fragments token by token into the form
`JSON.stringify` would produce, emitting only the prefix that is guaranteed to
match:

- Whitespace between tokens is dropped; structural characters pass through.
- Strings: escapes are decoded as they complete and the decoded text is
  re-escaped with `JSON.stringify` itself, per fragment, withholding a
  trailing high surrogate until its pair arrives. Object keys are held until
  complete.
- Numbers and literals are held until a delimiter and re-serialized through
  `JSON.parse`/`JSON.stringify`.
- On a duplicate key or an array-index-like key, whose canonical form cannot be
  known before the object closes, the transcoder switches permanently to raw
  passthrough from that token onward. The concatenation is then still valid
  JSON that parses to the same object; only its byte form differs from today's,
  in a case that is otherwise unreachable for schema-driven tool arguments.
  Malformed input also falls to passthrough rather than throwing.

`flush()` at model end completes any held token.

### Mapper (`@b4run/ag-ui`)

`toAguiEvents` handles the new chunk. The first `tool_call_args` for an id
flushes anonymous text (as `tool_call` does today), emits `TOOL_CALL_START`
and records the id as open with the characters sent so far; each delta emits
one `TOOL_CALL_ARGS`. When the `tool_call` chunk for an open id arrives, the
mapper computes today's payload with `stringifyArgs(input)`: if it extends what
was sent, the remainder goes out as a final delta; then `TOOL_CALL_END`. A
`tool_call` for an id that was never streamed takes today's three-frame path
unchanged, which is also the silent fallback for every provider that yields no
fragments. Streamed frames route through the ledger as passthrough events,
since only non-orchestration names ever stream. Run completion, interruption,
upstream error and an exhausted stream close any still-open streamed call with
`TOOL_CALL_END` so the AG-UI verifier's run-finish invariant holds.

### Runtime (`@b4run/cli`)

Both runtime layers already forward unknown chunk types verbatim, so the new
chunk reaches the mapper without changes. Two small adjustments: the
middleware `after` hook treats a `tool_call_args` chunk, like `tool_call`, as
proof the held message was not final; the live-tail renderer prints nothing
for argument fragments so the tail is not flooded.

## Alternatives

- Stream raw provider text and verify at model end: cannot retract bytes
  already sent, so a mismatch corrupts the payload. Rejected.
- Stream a canonical prefix by holding each object until it closes: guarantees
  identity in every case but defers the top-level object to the end, which is
  no streaming at all. Rejected.
- Token-level re-serialization with passthrough on the two order hazards:
  streams every practical payload byte-identically and degrades to valid,
  semantically identical JSON otherwise. Selected.

## Verification

Transcoder: randomized fragmentation of serialized objects concatenates to
`JSON.stringify` of the parse; raw whitespace, escapes, unicode, surrogates
and non-canonical numbers are canonicalized; duplicate and index-like keys
fall to passthrough that still parses to the same object. Adapter: a
multi-fragment turn yields deltas then the announce; a fragment-less turn is
byte-identical to today; two interleaved calls keep fragments separate by
index; orchestration names yield no deltas; a streamed then interrupted call
announces once across resume. Mapper: deltas concatenate to today's payload;
tail emission when the adapter held bytes; close-on-terminal paths. Wire: the
CLI AG-UI endpoint test asserts multiple `TOOL_CALL_ARGS` frames on the SSE
stream, and the conformance test runs a streamed call through `@ag-ui/client`
with `verifyEvents`. Existing tests pass unchanged. A manual live check against
OpenAI confirms deltas for a real provider.
