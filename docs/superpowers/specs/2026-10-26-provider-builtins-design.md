# B4 provider built-ins (slice 5)

## Scope and baseline

Continue the shared tool-step design, whose Rules are binding:
https://github.com/liveloveapp/hashbrown/blob/main/docs/superpowers/specs/2026-10-21-b4-tool-step-contract-design.md

Baseline: B4 main `1a4e4551b`. The SDK contract, server-tool emission/restore
(#1086), and plain LangGraph UI helper (#1098) have landed. Provider-native
activity is still discarded by the B4 model-stream projection. Canonical
AIMessage restore reads ordinary function calls but not provider steps or answer
annotations. Inbound provider-call filtering already exists and is retained.

File search remains deferred. Bedrock is not a B4 provider. Anthropic fetch and
code execution remain disabled while langchainjs#9911 is open. This slice does
not change storage from v0 or runnable streamEvents from v2.

## Normalization and native replay

Add a pure SDK normalizer shared by LangChain projection and AG-UI restore. It
accepts a structural AIMessage (or serialized kwargs), the provider when known,
and a stable message id. It returns provider calls (id, name, input, optional
readable result, current step) and optional answer annotations. Steps stored in
`additional_kwargs.b4_steps` are keyed by call id and omit `toolCallId`; answer
annotations are stored in `additional_kwargs.b4_answer`.

Recognized LangChain v1 server blocks are a fallback/enrichment input. Native
v0 data remains authoritative for status, source details, encrypted payloads,
and citations that standardization loses. Never mutate native content,
additional kwargs or response metadata. Provider calls never enter ordinary
`tool_calls`, tool execution, dangling-function repair, or synthetic persisted
ToolMessages. The canonical native AIMessage remains the model replay unit.

- OpenAI: read response-metadata progress tool_outputs objects, additional-kwargs
  terminal tool_outputs arrays, and final response-metadata output arrays.
  Normalize web search, code execution and image generation; use actual terminal
  status, including failed/incomplete code execution. Preserve source and file
  identity. Read native/v1 URL and file citations without duplicating occurrences.
- Anthropic: correlate server_tool_use and web_search_tool_result by native id,
  track invocation input deltas by block index, preserve raw search titles and
  error codes. Encrypted indices are not assistant character offsets.
- Google: normalize retained grounding metadata, citations and unmodified Search
  Suggestions. Grounding with no native call creates answer sources only. Code
  parts have deterministic message/ordinal identities. Never fabricate a search
  call merely because grounding exists.

Use bounded shared labels, stable call-scoped source ids, readable failures, and
the existing SDK merge rules. Missing results remain running; model EOF alone
does not prove success. Raw failure overrides a misleading v1 success block.
Use the canonical AIMessage id for derived call/source identities in both live
projection and restore; the stream event run_id remains only the live owner.

## Live stream and canonical persistence

Maintain normalization state per owner/model invocation. Announce provider
identity immediately when native identity arrives, before argument completion.
Emit the current step before lifecycle chunks so START/END/RESULT metadata is
correct. Reconcile final native output without duplicate calls/results. Keep
ordinary function calls on their existing path and preserve subagent ownership.

Add answer annotations before the matching model message is closed. The outbound
mapper attaches metadata["b4.answer"] to text framing, keyed to the invocation's
assistant message. Keep sources, citations and attribution separate.

Persist normalized kwargs on the actual AIMessage returned by the model handler
before createAgent checkpoints it, with the same treatment in B4's independent
invoke loop. Callback-output mutation is not persistence. Custom runnable routes
can use the normalization middleware/helper where B4 does not own their graph.

AG-UI restore reads the stored provider map and native message through the same
normalizer, synthesizes standard tool lifecycle frames, carries failed-result
errors, and attaches answer annotations to the original assistant owner. The
view stores answer annotations by message id so citation spans are not applied
to concatenated turn prose. Live and restored views must agree.

## Enabling options and Google boundary

An author-facing agent() builtInTools option is a pending user preference. It
must use the shared capability vocabulary, validate against the resolved
provider, preserve ordinary app tools, and supply required source plumbing.

The installed Google integration is @langchain/google-genai 2.3.2, backed by
@google/generative-ai. It drops metadata-only streaming chunks and does not
support native invocation parts. A superclass-output wrapper cannot recover
discarded data. Replacing it with current @langchain/google is pending explicit
dependency approval. Do not silently buffer built-ins or claim guaranteed Google
attribution from the deprecated transport. Normalize custom-route data when
present; gate unsupported enabling until the approved transport path is tested.

The audited replacement @langchain/google 0.2.12 requires @langchain/core
^1.2.18. Replacement alone still loses some native parts and metadata-only
candidates on the graph-v2 streaming path. Its public GenerateContentApiHandler
and apiHandler factory permit a narrow retaining bridge: delegate transport to
the superclass, capture its raw google-chunk/google-response callback events in
per-invocation state, and retain ordered raw candidates in v0 additional kwargs.
Wrap records so native candidate index fields cannot make LangChain merge
distinct fragments. Flush metadata-only candidates even when no text chunk was
produced, and forward token callbacks once. Rebuild native input parts from those
records on replay without adding type fields or changing signatures. No private
member casts, package-private imports, global queues, or duplicated transport.
Test this bridge offline before enabling Google; graph streamEvents v2 uses the
legacy chunk handler, not the new chat-model-event converter.

## Verification

Use top-level test(...) with arrange/act/assert and failing tests before code.
Test SDK-shaped chunks and real LangChain AIMessage/checkpoint round trips;
no live recordings or credentials. Cover immediate START, partial args, actual
settlement/failure, final reconciliation, source/citation identities, call-less
grounding, Google attribution, native replay, collisions, owner isolation,
cancellation, restore, and immutable inputs. Keep the shared SDK fixture corpus
green. Run affected package build/test/lint/typecheck, docs checks and changeset
checks, then the repository validation lanes. Report existing warnings.
