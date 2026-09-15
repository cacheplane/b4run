# Preserve concurrent model messages

## Problem and scope

Concurrent nested chat models currently emit anonymous text tokens. The default
AG-UI route appends them to one assistant message, corrupting independent text
or JSON responses. Fix AG-UI model-message framing while retaining raw SSE compatibility, without adding
application-specific hooks or changing tool approval semantics.

## Design

Add optional `messageId` metadata to existing string-valued token chunks. The
LangChain model invocation `run_id` identifies a message within one execution.
Emit a reserved `message_end` chunk carrying `{ messageId }` at model completion.
Only models that emitted text need a completion chunk, preserving retry before
first output. Completion precedes same-model tool announcements. Unknown or
duplicate completions never close unrelated messages. Subagent activity keeps
its existing projection and identity.

Carry token metadata through runtime `chunk` events and AG-UI normalization.
Preserve the existing raw Agent Protocol SSE `chunk` string payload; NDJSON and
in-process chunks may carry additive metadata. No existing token payload becomes
an object. Older anonymous-token producers retain their current framing. Raw SSE clients
continue to receive flattened string chunks; independent framing is provided
by AG-UI and metadata-aware in-process/NDJSON consumers. Live-turn digest
coalescing must preserve identity and merge only adjacent chunks with equal
message IDs (anonymous only with anonymous).

The AG-UI translator allocates an output message ID on the first identified
nonempty token, tracks each source message separately, and ends that message on
its completion event. Concurrent message content can interleave by ID. Tool
calls/results and unknown extension events continue to close legacy anonymous
text, but do not end another model's identified message. Run completion,
interruption, upstream errors, and exhausted streams close every remaining open
message exactly once. Empty model output produces no text message. Message IDs
are scoped to a translator execution; retries use distinct model run identities.

This is not replay deduplication: work inside an interrupted graph node can run
again on resume. Applications should checkpoint generation before approval.

## Alternatives

- Buffer entire concurrent messages: delays streaming and grows memory with
  response length. Rejected.
- Serialize tool execution: changes agent behavior and latency to compensate for
  a transport defect. Rejected.
- Carry identity through existing events: additive metadata, bounded lifecycle
  state, and no new author configuration. Selected.

## Verification

Tests must cover interleaved valid JSON remaining two independent messages;
legacy anonymous tokens; sequential models with no tool boundary; empty output;
completion, interruption, exhausted streams and errors; subagent projection;
reserved-event filtering; raw SSE payload compatibility; and the default HTTP
agent route with concurrent generation tools followed by approval and resume.
The HTTP regression must fail before implementation. Use deterministic model
fixtures, not provider-dependent assertions. Run affected package builds,
typechecks, lint and tests, then repository validation and required CI before
merging. No new dependencies.
