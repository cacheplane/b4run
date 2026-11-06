# B4 Agent Protocol wire design

Date: 2026-11-05

Status: Approved by Brian on 2026-11-05 after independent specification review,
including the concrete names, envelopes and bounds below.

This is the wire contract for the coordinated release. The companion runtime,
client and release specifications supply persistence, consumer and delivery
requirements. The already-approved Store specification governs Store details.
No runtime implementation or conformance result is claimed by this document.

## 1. Normative inputs and corrections

Pin the original [OpenAPI 0.1.6](https://github.com/langchain-ai/agent-protocol/blob/455acf2eb2c55c634350f4c6a8da117d0ecfa7b1/openapi.json),
[CDDL 0.0.20](https://github.com/langchain-ai/agent-protocol/blob/455acf2eb2c55c634350f4c6a8da117d0ecfa7b1/streaming/protocol.cddl)
and AG-UI 1.0 source at `08eae9dc13546e91272efb2d0ef863e21acc6ee3`.
Keep upstream files verbatim with hashes in the eventual contract-fixture manifest.
Generate tests/types from a separate, reviewed correction overlay:

- Remove only the erroneous response-field `required` array from
  `RunStream.allOf[1]`; retain Run's own required response fields.
- OpenAPI paths and CDDL camelCase command fields prevail over inconsistent
  README examples, including `/stream/events` and thread-scoped Run paths.
- Upstream does not define REST Run SSE payload framing, webhook payload/retries,
  B4 turn grouping or recovery. The policies below are B4 choices, not corrections.

Ordinary text-array Message content validates unchanged: its block branches use
anyOf, not an exclusive oneOf. Do not add a speculative correction for overlapping
text/any-block branches. Only reproduced defects belong in the overlay.

## 2. Complete operation inventory

| Stage | Operations |
| --- | --- |
| Agents | POST `/agents/search`; GET `/agents/{agent_id}`; GET `/agents/{agent_id}/schemas` |
| Threads | POST `/threads`; POST `/threads/search`; GET/PATCH/DELETE `/threads/{thread_id}`; GET `/threads/{thread_id}/history`; POST `/threads/{thread_id}/copy` |
| Runs | POST `/runs/stream`; POST `/runs/wait` |
| Background Runs | POST `/runs`; POST `/runs/search`; GET/DELETE `/runs/{run_id}`; GET `/runs/{run_id}/wait`; GET `/runs/{run_id}/stream`; POST `/runs/{run_id}/cancel` |
| Streaming | POST `/threads/{thread_id}/stream`; GET `/threads/{thread_id}/stream` (WebSocket upgrade); POST `/threads/{thread_id}/commands` |
| Store | GET/PUT/DELETE `/store/items`; POST `/store/items/search`; POST `/store/namespaces` |

There are exactly six additional operations: POST `/agui/{routeId}`, GET
`/healthz`, GET `/readyz`, opt-in POST `/threads/{thread_id}/workspace/inspect`,
opt-in PUT `/workspace/sources/{digest}`, and POST `/store/items/approve`.
Store approval is an extension even though its URL is under Store.
Remove the old state/turns/events/pending/resume/cancel/thread-Run dialect and
GET `/agui/{routeId}` without aliases. Reserve protocol paths ahead of SPA
fallback; unsupported methods return 405 and removed paths 404, never HTML.
Application routes and Inspector's separate API are outside this inventory.

Thread/Run/checkpoint IDs are canonical lowercase UUID strings. Agent IDs are
opaque text, preserving `${routeId}#${kind}` for every public runnable
`agent|chain|graph|workflow`. Decode path parameters once; encode Agent IDs as
single path components. Do not change ID case or split `#` as a URL fragment.
Dates use UTC RFC 3339 strings; ASP timestamps use epoch milliseconds.

## 3. Catalog and capability vocabulary

Use standard `ap.io.messages` and `ap.io.streaming` booleans truthfully. Omitted
capabilities remain unknown. Publish these reverse-domain extension keys:

| Capability | Value |
| --- | --- |
| `run.b4.protocol` | `{v:1, openapi:"0.1.6", cddl:"0.0.20", profile:"node-sqlite"|"node-postgres"|"host-reduced", transports:{sse:boolean,commands:boolean,websocket:boolean}, backgroundRuns:boolean, continueAfterDisconnect:boolean,webhooks:boolean}` |
| `run.b4.recovery` | `{v:1, threadMetadata:"b4", historyMetadata:"b4", eventEnvelope:"b4", replaySeconds:86400, replayBytes:67108864, resultSecondsAfterTemporaryCleanup:604800, receiptSecondsAfterSettlement:604800}` with effective configured limits |
| `run.b4.permissions` | `{v:1, completeSet:true, decisions:["once","always","deny"], grants:"off"|"optional"|"required", allowAlways:boolean, responseSchema:object}` |
| `run.b4.controls` | `{v:1, injection:boolean, rollback:boolean, stateEdit:boolean, copy:boolean, fork:boolean, forkNamespaces:"root"|"declared", resume:{update:boolean,goto:boolean,config:boolean}, systemInjection:boolean}` |
| `run.b4.agui` | `{v:1, path:string, capabilities:AgentCapabilities}` using the full pinned native declaration, including unknown omissions |
| `run.b4.workspace` | `{v:1, inspect:boolean, staging:boolean}` only when enabled; effective limits live in Agent metadata below |
| `run.b4.store` | `{v:1, generic:boolean, managedMemory:boolean, conditionalWrites:true, approval:boolean}` |

The service-level facts are repeated identically on authorized Agent resources;
route-specific facts are derived from the resolved adapter, policy and stores.
Do not claim support because a key was configured or because a route is an agent.
Agent `metadata.b4` is server-owned `{v:1, kind, isDefault, schemas, limits}`.
`schemas` holds JSON Schemas for B4 injection input, controlled state edits,
resume routing/config, recovery and custom payloads. `limits` names effective
request/inbox/viewer/inspection/staging limits; no separate discovery endpoint.
Return standard AgentSchema input/output/state/config schemas without fabricating
chat schemas for a raw graph. b4app requires a compatible messages input/output.

Add author config `server.agentProtocol.defaultAgentId`. A sole public runnable
route is the automatic default; multiple routes require an explicit valid ID
for omitted REST agent selection. Validate at check/build/boot; absence with
multiple routes is 422 `agent_required` on an omitted-agent request, rather than
breaking explicit-ID requests. An explicitly configured invalid/denied default
never falls back to another route. CDDL still requires `assistantId`.

## 4. Caller metadata and protected server fields

Reserve the top-level key `b4` in Thread/Run/ThreadState metadata and B4 ASP
Event/ResponseMeta carriers. Other caller metadata remains ordinary annotations,
never authority. Caller Thread create/PATCH metadata cannot set `b4`.
Caller Run/command metadata may contain only this request-side B4 object:

```json
{"b4":{"v":1,"submissionId":"a-client-generated-UUID","expected":{"generation":"thread-generation-UUID","runId":"canonical-Run-UUID","pausedGeneration":"pause-UUID"}}}
```

All fields except `v` are optional; `expected` members are independently optional.
A supplied expectation is checked atomically before mutation, not ignored.
The B4 client always supplies relevant expectations. The standard client may
omit the entire object. Unknown request-side B4 keys or unsupported B4 versions
return an explicit error; do not silently accept forged `turnId`, status, receipt,
namespace/principal or lifecycle fields. A supplied submissionId is a UUID.

Run metadata returned by the server replaces the request-side B4 object with:
`{v:1,generation,turnId,previousRunId?,phase,reason?,continuation,submissionId?,
acceptedAt,startedAt?,settledAt?,effectsUncertain,submissionKind?,webhook?}`.
`phase` is `accepted|running|settled`; `continuation` is `none|waiting|closed`.
`reason` is `completed|permission|user_stop|server_shutdown|deadline|execution_error|
execution_lost|client_disconnect`. `previousRunId` links the immediately preceding segment;
`turnId` is the initial Run UUID. A paused segment keeps reason `permission`
after a later stop; current turn closure is separate recovery data.
Do not attach a mutable "latest Run" field to every historical Run.

Canonical Run statuses stay `pending|success|interrupted|timeout|error`.
Thread status is busy during accepted/running/draining/rollback work,
interrupted only for actionable pending continuation, error after an unhandled
latest failure, otherwise idle. Current cancellation/maintenance progress is in
Thread recovery, not a new status enum. Independent user annotations merge by
key in metadata-only PATCH; state values shallow-merge at the top level through
the route's declared reducer/validation, never recursively merge arbitrary JSON.

For message-capable routes, REST messages use public roles `user|assistant|
system|tool` and native blocks, preserving unknown block types and IDs. Map
ASP `human|ai|system` explicitly; tool facts use the tools channel. Preserve
multimodal, reasoning, provider activity and answer annotations. Do not expose
LangChain `lc/id/kwargs` serialization as the Message wire format. If returning
Thread.messages, remove the duplicate messages field from Thread.values.
Top-level Run messages combine with input.messages through the declared message
reducer in that order, preserving matching IDs and rejecting conflicting duplicate
IDs. Non-object input plus top-level messages requires an adapter schema that
accepts both; otherwise return a route-input validation error, never drop either.

## 5. Defaults, reads and REST Run streaming

| Omitted option | Behavior |
| --- | --- |
| REST on_disconnect | cancel for the execution-owning creation stream; continue is honored |
| REST missing supplied thread | reject 404; explicit if_not_exists=create authorizes then creates |
| REST omitted thread | temporary/stateless thread; retain Run/result separately |
| REST on_completion | delete without supplied thread_id, keep with one; authorized overrides honored |
| duplicate Thread create | raise 409; do_nothing returns existing unchanged 200 after authorization |
| Run stream_mode | values; scalar or array of values/messages/updates/custom honored |
| cancel action / wait | interrupt / false |
| search limit / offset | 10 / 0 with source-specific bounds; history 10; namespace listing 100 / 0 |

Use deterministic live search order: Agents by agent_id ascending; Threads and
Runs by created_at descending then ID ascending. Equality metadata/values filters
AND their literal top-level JSON keys; name search is case-insensitive substring.
Authorize before pagination; no claim of a frozen offset search snapshot.
The reserved B4 operation-lookup selectors in section 6 are the only explicit
exception to ordinary top-level metadata equality; generic metadata keys retain
the equality rule.
Do not invent upstream min/max bounds where absent; apply separately documented
service quotas (history response cap 1000 records, explicit rejection above cap).
Store ordering/filter/bounds follow its own approved spec.

POST /runs returns 200 Run only after durable acceptance. Wait endpoints return
RunWaitResponse at execution-segment settlement, including permission park.
They do not wait indefinitely for future continuation segments of the user turn.
GET Run stream joins only future output as upstream says; it is not replay.
A settled join returns a normal bounded stream ending promptly, without historical
deltas. Thread ASP is the replay surface. For non-object route output, RunWaitResponse.values is
`{output:result}`; stateful adapters return their declared public state object.
Never force a scalar result into an object schema by discarding it.

B4 defines REST Run SSE framing separately from ASP: initial `event: metadata`
contains `{run: Run}`; each requested mode has event name `values|messages|
updates|custom` and JSON data in that mode's documented public representation;
`event: end` contains RunWaitResponse at settlement. `event: error` contains
standard ErrorResponse for a stream fault. Values is a state object; messages
is a complete/current public Message on each change (replacement by ID, not
an undocumented text delta); updates is `{namespace,node?,values}`; custom is
`{namespace,name?,payload}`. `id:` is the source canonical eventId where a
journal fact supplies it; control/end frames need no invented sequence.
Pre-admission errors use HTTP JSON; an admitted execution error still has its
canonical Run outcome and terminal end. SSE comments are keepalives only.
A retry stream never creates a second Run. Inability to replay a creation stream
is a recoverable error with the original Run/receipt correlation.

REST RunCreate on an actionable paused thread uses input as the resume value;
initial messages cannot implicitly resume a permission. ASP run.start follows
its pinned idle/start, interrupted/resume, active/inject state machine. For one
pending prompt its input is that prompt's response; for multiple, input is
`{responses:[{namespace,interruptId,response},...]}`. Both normalize through the
same validator as input.respond. A new user turn after stop never resumes the
retired continuation; runtime reconciliation is specified separately.

## 6. Submission receipts and command results

Use RunCreate.metadata.b4 or run.start/input.respond params.metadata.b4 for the
submissionId/expectations. input.inject uses `params.message.b4` (InputMessage
is extensible). state.fork uses top-level Command.b4 (Command is extensible,
StateForkParams is closed). No extra metadata member in InputRespondEntry or
StateForkParams. Plain numeric command id is only transport correlation.

Fingerprint the normalized operation: deployment/principal scope, method/target,
selected agent, thread and expected generation, input/messages, sorted prompt
addresses/answers, resolved defaults, updates/goto/config and caller metadata.
Exclude transport command id, trace-only correlation, token itself and JSON
object key order; preserve arrays other than the set-like sorted response list.
Resolve a repeated omitted/default request against the original receipt, not a
new catalog default. Different payload under the same token conflicts.

For input.respond/input.inject extensible results, return:
`{runId, b4:{v:1,receipt:{submissionId,submissionKind,runId,turnId,acceptedAt,replayed,disposition}}}`.
`disposition` is `accepted|applied|not_applied`; injection may additionally include
`inputId` and `reason`. run.start's closed RunResult stays `{runId}`; receipt
correlation goes in extensible ResponseMeta.b4 instead. state.fork's closed
result stays `{threadId,runId}`, also using ResponseMeta.b4. ResponseMeta includes
appliedThroughSeq only for facts durably projected through that boundary.
A POST retry returns the original receipt/current authorized Run, not a new input.

Read-only operation reconciliation uses POST /runs/search with explicit reserved
literal metadata selectors (a declared B4 query extension):
`{"metadata":{"b4.submissionId":"token","b4.submissionKind":"b4"},"limit":1,"offset":0}`.
submissionKind is b4 for UUID tokens or agui for arbitrary native run IDs.
Optional `b4.operationThreadId` selects the original command Thread (including a
fork source); `b4.targetRunId` selects an injection/continuation target. Standard
thread_id/agent_id/status and other metadata filters still constrain the actual
returned Run. An unscoped token matching several authorized operation targets
returns 409 submission_ambiguous before pagination and requires target selectors;
do not silently pick the first match. These selector names never mean JSON dot-path traversal or partial
equality against metadata.b4. Reject caller mutation of these reserved selectors
as Thread/Run annotations. B4 clients use this exact query, not a nested partial
b4 object or text matching. The internal scoped ledger indexes every accepted
initial/resume/fork/injection token, including many operations on one Run.

For a retained authorized match, return the actual canonical Run once with
`metadata.b4.lookup:{submissionId,submissionKind,state:"accepted",receipt:Receipt}`.
This query-scoped projection does not mutate stored Run metadata or dump all
injection receipts. Run GET returns ordinary admission correlation and current
state; use the exact lookup query for a particular non-admission token. If the
Run remains but the full operation receipt expired, lookup state is expired
without receipt; the authorized Run still supplies its identity/outcome. If a
known token's target Run was deleted/rolled back, return 409
submission_target_gone with only authorized minimal token/correlation diagnostics,
not a fake Run. No match returns [] and means no authorized retained correlation,
never proof that the operation did not arrive or a license to resend after expiry.
Scope lookup by principal/target before disclosure. Apply authorization before
receipt lookup; an exact accepted retry is resolved before validating its now-
consumed pause/old head expectation. New operations must pass current expectations.

The seven-day full receipt window begins at settlement; unresolved obligations
are retained. Retain minimal spent-token/generation tombstones while the target
can otherwise make replay unsafe. Once a full receipt is gone, a known spent
token fails `receipt_expired` and cannot be treated as fresh work. Initial tokens
on a retained thread remain spent for its lifetime; for deleted/temporary threads
retain private tombstones for seven days after cleanup plus any outstanding
obligation, then clients have no retry guarantee and must not resend. Random
UUID token uniqueness remains required. Do not claim eternal deduplication.

## 7. Permission requests and responses

For B4 permissions, input.requested data is
`{interruptId,payload:{type:"b4.permission",v:1,request:object,responseSchema:object,
allowedDecisions:[...],allowAlways:boolean},b4:{v:1,pausedGeneration,proposalHash,
status,expiresAt?,grant?}}`. request preserves existing kind/detail/toolCallId/
display labels and provenance. `status` is waiting/expired; recovery also records
resolved/denied/abandoned/stopped dispositions. Grant and proposal hash are opaque;
clients do not recompute server-selected patterns. Generic interrupt payloads
retain their own schemas and only get correlation metadata where permitted.

B4 response is exactly `{decision:"once"|"always"|"deny",grant?:string}`.
One prompt accepts InputRespondOne; many require all addressed entries once in
InputRespondMany. Validate complete set, caller/provenance, exact paused generation,
schemas, grants and overrides before any consumption. allowAlways=false downgrades
always to once without saving a rule. Existing deny rules/constraints prevail.
Optional grant mode still requires a row when one exists; required fails closed;
off remains the default. Expired positive responses fail. Bound negative
abandonment to current prompt/proposal/generation and authentic token where
required, but allow it despite time expiry. It executes no gated action.
Stop uses exact Run cancel and executes no continuation at all.

Controlled update/goto/config validate route schemas and separate authorities;
reject edits to a protected proposal with `approval_changed`, requiring a fresh
approval rather than consuming the old one. Reserved config includes thread_id,
run_id, checkpoint_id/checkpoint_ns, principal, namespace/owner/fence, permissions,
grant/store/sandbox handles. Whitelist route config; no unchecked forwarding.
Batch overrides apply once at the resumed superstep. Unsupported nested routing
or adapter hooks fail before acceptance.

## 8. Canonical ASP observation and recovery

Canonical event seq is monotonic across Runs/restarts within a thread generation,
starting at 1, bounded by 9007199254740991. eventId is
`b4e1.<generation-UUID>.<decimal-seq>`. The mapping is stable; SSE `id:` is eventId,
not decimal seq. Use `event: message` and JSON CDDL Event in `data:`. Event's
legal extensible top-level `b4` holds `{v:1,generation,runId,turnId}` for every
Run-associated fact; administrative thread facts omit Run/turn when inapplicable.
Never add runId/reason to closed lifecycle data. Namespace identity is an array;
compare prefix components, not slash strings. Filtered seq gaps are normal.

SSE EventStreamRequest optionally includes legal extension
`b4:{v:1,generation}`. B4-aware recovery supplies it with since=H. Mismatch returns
409 resync_required before streaming. Standard numeric-since clients without a
generation operate on the current incarnation and cannot claim B4's protection
against intentional UUID reuse. Unknown/ahead/expired since returns explicit
resync_required with oldest/latest authorized bounds, never a silent jump.
If a subscribed values baseline is sent, it is a derived hydration frame from
committed state, with no eventId/seq and top-level
`b4:{v:1,generation,delivery:"snapshot",throughSeq:H}`. With since it describes
state at exactly since; without since, use the coherent live join boundary H.
Then replay only >H and join live atomically. This adds no new journal fact or
sequence for a read. If a baseline cannot be reconstructed at since, require
resync rather than send current values followed by older deltas.

WebSocket subscribe IDs are opaque authenticated filter descriptors scoped to
principal/deployment/thread generation, not bearer authority. Encode the filter
and a nonce in the ID, retaining verification keys for the replay window; no
durable socket/subscription table is needed. reconnect validates runId,
lastEventId and supplied descriptors, reauthorizes their filters and restores
subscriptions on the new socket. Expired/invalid replay returns restored=false
and ResponseMeta.b4 `{v:1,code:"resync_required",generation,oldestSeq,latestSeq}`;
no missed-event success is fabricated. Unknown descriptors return the standard
no_such_subscription. runId references an authorized correlated Run, not the
current-run pointer alone. Socket closure only unsubscribes.

Thread GET metadata.b4 is the coherent RecoveryV1 object:
`{v:1,generation,throughSeq,eventId:null|string,revision,checkpoint?,history,
turn:null|TurnSummary,run:null|RunSummary,pending:[PendingInput],activity:[Activity],
maintenance:null|Maintenance,retention}`. Null eventId is legal only at H=0.
The snapshot and all standard Thread fields share H/revision. Pending is complete
for the authorized scope; it is never silently truncated. RunSummary includes
canonical IDs/status/phase/reason/effectsUncertain; TurnSummary adds currentRunId,
state `running|waiting|completed|stopped|error|timeout` and continuation eligibility.
Maintenance is `{operationId,type:"rollback"|"delete",state:"requested"|"draining"|
"cleaning"|"failed",targetRunId?}`. Ordinary collection summaries omit private grants and receipt payloads; the
explicit authorized operation-lookup query returns only its declared public
receipt correlation, never grant material. StateGetResult remains only values/checkpoint.

Recovery activity is a lossless typed projection using stable identities:
`{id,namespace,runId,turnId,type,payload,state,sourceSeq,effectsUncertain}`; type is
`message|tool|plan|reasoning|subagent|provider|answer|input|outcome` and payload is
the existing versioned public Message/B4ToolStep/plan/AG-UI-compatible activity
shape. Unknown optional types are preserved opaquely. State is open/completed/
interrupted/failed/denied/cancelled/historical where applicable, not an inferred
success. effectsUncertain is true for any activity whose external effect is
unresolved; failed/interrupted never implies the tool did not execute. Message content lives in standard fields; activity refers to its ID
instead of duplicating full text. All active/open items remain recoverable;
closed recent activity is bounded to 256 entries/1 MiB, with explicit coverage
and history anchor. Apply service admission bounds before an unrepresentable
complete pending/open set could be accepted; fail snapshot size explicitly,
never silently omit actionable prompts or claim truncated data complete.

`history` is `{anchor,nextBefore:null|string,complete:boolean}`. Each standard
ThreadState.metadata.b4 carries `{v:1,generation,revision,namespace,lineage,
throughSeq,history:{anchor,nextBefore,complete},activity:[...]}` for its page
coverage. `before` accepts either an authorized checkpoint UUID (new pinned
ancestry at that checkpoint) or an opaque authenticated `b4h1.` cursor encoding
generation/revision/branch/position. Follow returned nextBefore for frozen paging.
No pagination-header requirement and no new request parameter. Deleted/invalid
ancestry requires 409 history_changed; pruned unavailable data 410 history_expired.
Large activity between checkpoints is paged as fragments with the same checkpoint
and explicit fragment ordinal in lineage; no fake checkpoint is created. A page
is not complete until nextBefore=null. Reads never mutate old event payloads.

Live supplemental facts use standard custom with data
`{name:"b4.run"|"b4.turn"|"b4.input"|"b4.activity"|"b4.history",payload:{v:1,...}}`.
Payload is the corresponding RunSummary/TurnSummary/inbox disposition/Activity/
`{revision,reason:"rollback"|"state_edit",removedRunIds:[...]}`. Standard message,
tool, lifecycle and checkpoint facts stay on their standard channels. Publish
reserved B4 custom names only from the runtime; application writer name collisions
fail explicitly. Replay/history use current authorization; expired historical
grants are never redisclosed as actionable authority.

## 9. Native AG-UI identity and continuation

Keep native RunAgentInput, accepted arbitrary string threadId/runId, messages,
state, tools, context, forwardedProps and standard resume shape. Keep existing
forwarded-property/client-tool/structured-output gates and multimodal/reasoning/
provider content behavior. Do not require B4-specific fields from a normal native
client. JSON input plus existing Accept negotiation selects SSE or protobuf.
Native request/response disconnect requests cooperative cancellation, preserving
the existing behavior; no new native continue parameter is added. Each response
has a valid native lifecycle; one interrupted run closes and its
resume uses a new native runId/canonical continuation. Never emit a second
terminal event for a previously closed wire run. ASP injection is not an AG-UI
second-POST intervention feature.

A native UUID threadId addresses that exact canonical Thread after authorization,
with permitted lazy creation. A non-UUID native threadId uses a durable alias
key `(deployment,principalScope,agentId,nativeThreadId)` to a canonical UUID;
echo the original string on native frames. Never infer authority from an alias.
Run aliases key `(threadGeneration,principalScope,agentId,nativeRunId)` and map
to the canonical per-segment UUID. A different body under an admitted nativeRunId
conflicts. Keep aliases while the thread/receipt needs them; explicit deletion
invalidates them and does not reconnect a reused native name to old state.

The native runId acts as its submission token. A repeated accepted POST must
not execute again. Return 409 `submission_already_accepted` with an authorized
`metadata.b4` receipt/Run correlation for reconciliation through standard
resources; do not return JSON pretending to be a new successful AG-UI stream.
This is a declared duplicate-submission response, not a native stream re-entry
protocol. The B4 connector understands it. Ordinary HttpAgent use with fresh
run IDs is unchanged; no automatic recovery by generic native clients is claimed.

Native permission resume retains its standard decision payload and
`metadata.grant`. A native cancelled entry is negative abandonment, including
expiry handling, not whole-turn stop. Shared validation covers the full pending
set. B4-aware recovery translates standard Thread/history data into valid AG-UI
message/state/activity snapshots by original IDs, then follows the ASP journal;
no native cursor request or capability GET /agui is added.

## 10. Retained extension payloads

GET healthz returns 200 `{status:"ready"}` without touching dependencies or
inference. GET readyz returns 200 or 503
`{status:"ready"|"not_ready",checks:{[component]:{status:"ready"|"not_ready",code?}}}`.
Check only required resolved stores/coordinator/executor readiness with bounded
redacted diagnostics; absent optional components are omitted. Helm liveness uses
healthz and readiness uses readyz. No inference, embedding, model billing or
provider-auth probe is a readiness condition.

Inspection request keeps optional `root`, `excludeRootDirectories`,
`expectedRootSymlinks`, `ignorePrefixes`, `maxEntries`, `maxFileBytes`,
`maxTotalBytes`; defaults are empty collections, 10000 entries, 2 MiB/file,
16 MiB total. Caps are 10000 entries, 16 MiB/file, 32 MiB total; reject excess,
never silently clamp. Request body cap is 64 KiB and serialized response cap
64 MiB. Response keeps `{threadId,sourceDigest,intentDigest,root?,inspection:
{files,symlinks,totalBytes,entries}}`. Preserve canonical-root/path/symlink rules,
source correlation, read-only provider inspection, change detection and output
filtering after limits. This is a separate inspection lease, not a Run. Abort
on request cancellation, deadline or shutdown and release only after provider
unwind; exact-run cancel cannot accidentally cancel this read or later execution.

Staging body remains SourceBundle `{version:1,digest,files:[{path,base64,executable}]}`.
The lowercase 64-hex URL digest must match verification using the existing
b4-workspace-source-v1 canonical hash algorithm; preserve portable sorted paths,
canonical base64 and collision/byte validation. Response `{digest,status:"created"|
"held"}` has HTTP 201/200. Enforce configured staged quota/upload bytes/deadline,
one per-process body decode slot (429 Retry-After:1), and durable shared quota/
uploader policy before retaining bytes. Staging starts no Run/workspace.

ThreadCreate keeps its declared B4 `workspace` extension
`{sourceDigest,environmentLinks?:[{path,target}],baseline?:"git"}` outside metadata.
Require an explicit thread-access policy when enabling staging/inspection.
Authorize/validate staged reference and uploader before creating a Thread; bind
source association atomically or invisibly stage/compensate before exposing it.
Do not accept uploadedBy from the caller. if_exists=do_nothing never attaches or
changes an existing workspace; a new body cannot silently mutate the old Thread.
Old unconditional top-level route/resume dialect fields are rejected as retired
request forms, not interpreted as aliases or fed to a default agent.

Approval body/result/errors and generic Store root namespace, ETag/If-Match,
filter, pagination and authority are exactly those in the approved Store spec.
None of the retained workspace/Store payloads grants generic clients ownership
of runtime journal, grants, receipts, inbox or executor records.

## 11. Errors and resource visibility

REST uses `{code,message,metadata?}` at the top level; no error.details.code
wrapper. Additional statuses below are B4 response policy, not upstream edits.
ASP POST commands return HTTP 200 correlated CDDL success/error once authenticated
and parsed. Malformed JSON/body/transport/auth failures use HTTP errors before
command processing. A valid in-band failure stays in the closed ErrorCode enum;
specific B4 diagnostics use `meta.b4:{v:1,code,...}`. Never send stacktrace in
production or include private target details before authorization.

| Failure | HTTP status/code | ASP error / B4 diagnostic |
| --- | --- | --- |
| malformed JSON / invalid schema | 400 malformed_json / 422 invalid_argument | invalid_argument / invalid_argument |
| unauthenticated | 401 auth_required | handshake HTTP 401; expired command authority permission_denied |
| inaccessible or absent Thread/Run/checkpoint/input | 404 not_found | no_such_run, no_such_checkpoint, no_such_interrupt or no_such_namespace without existence leakage; thread access denial permission_denied |
| duplicate Thread raise | 409 thread_exists | no applicable command |
| run busy / conflicting mutation | 409 thread_busy | invalid_argument / thread_busy |
| expectation/paused generation changed | 409 stale_generation | no_such_interrupt for stale answer; otherwise invalid_argument / stale_generation |
| incomplete/duplicate answer set | 422 incomplete_responses | invalid_argument / incomplete_responses |
| invalid/expired grant | 403 grant_invalid / grant_expired | permission_denied / same diagnostic |
| changed protected proposal | 409 approval_changed | invalid_argument / approval_changed |
| unsupported host/adapter/control | 422 not_supported | not_supported / feature name |
| replay/history mismatch | 409 resync_required / history_changed | reconnect restored=false with meta, or invalid_argument / resync_required |
| pruned history/result known to authorized owner | 410 history_expired / result_expired | invalid_argument / history_expired; missing generic resource remains 404 |
| same submission token/different input | 409 submission_conflict | invalid_argument / submission_conflict |
| full receipt gone for spent token | 409 receipt_expired | invalid_argument / receipt_expired |
| inbox/viewer/admission capacity | 429 capacity_exceeded plus Retry-After | invalid_argument / capacity_exceeded |
| required storage/coordinator unavailable | 503 storage_unavailable | unknown_error / storage_unavailable |

Store conditional mutation retains 412 and approval revision conflict 409
item_changed per its spec. Retained workspace domain codes/statuses remain as
at the audited source, wrapped in the new top-level ErrorResponse. Server quotas
use 413 for body bytes, 429 for admission and 507 for durable capacity, with no
partial accepted operation. A slow live socket closes explicitly (WebSocket 1013;
SSE disconnect after a CDDL-compatible control error if possible); its durable
cursor remains replayable. Client abort is not a successful command receipt.

## 12. Remaining standard webhook field and resource limits

Do not silently ignore RunCreate.webhook. On the full Node reference, enqueue
a durable POST callback at segment settlement containing RunWaitResponse.
Permission park is segment settlement, not the end of the logical turn. Send
`Content-Type: application/json` and stable `B4-Webhook-Id` equal to the Run UUID.
Delivery is at least once; receivers deduplicate. A webhook failure cannot
rewrite the Run outcome. Expose only delivery state/attempt count in Run.b4;
no new webhook/receipt endpoint. Retain bounded delivery records seven days
after settlement or until a bounded in-progress delivery settles.

Validate URI and caller webhook authority before Run acceptance. Use configured
server egress policy; built-in policy allows HTTPS public destinations and
refuses userinfo, redirects, private/link-local/loopback destinations (including
DNS resolution/rebinding at delivery; dial the validated address with the
original TLS server name rather than resolve again unchecked). Explicit app egress policy may authorize
private service destinations. Do not inherit caller Authorization/cookies. Any configured callback authority
is server-managed by the egress policy, never credentials embedded in the URI. Five total attempts use delays
0/2/10/60/300 seconds, 10-second request timeout, bounded response discard at
64 KiB; retry network/408/429/5xx, honor bounded Retry-After within this budget,
mark other non-2xx failures terminal. The delivery budget is 10 minutes from
settlement; a restart past that budget marks delivery failed without another POST. Reduced hosts without a durable delivery
adapter reject webhook before admission and advertise `webhooks:false` in
run.b4.protocol (full Node true). This B4 payload/retry policy closes an
underspecified upstream option; it adds no public operation.

Initial configurable service limits: ordinary JSON command/Run bodies 1 MiB;
64 pending prompts per pause; injection inbox 128 entries/1 MiB, individual text
64 KiB; per-observer buffer 1024 events/4 MiB. Check quotas before acceptance,
including callback/inbox capacity. A single required snapshot/event above its
configured output ceiling fails explicitly; do not truncate prompt authority or
silently drop a large authorized model/tool result. Existing larger workspace/
staging limits are separate. Effective limits are advertised and used in tests.

## 13. Recovery definitions and representative exchanges

In the definitions below `?` means optional, `[]` is an array, `UUID` has the
canonical form above and Namespace is the pinned string array. Listed required
members are not placeholders; unknown server extension members may be ignored,
but clients cannot forge these objects in request metadata.

| Object | Required members; optional members marked ? |
| --- | --- |
| RunSummary | runId:UUID, turnId:UUID, agentId:string, status:RunStatus, phase:accepted/running/settled, continuation:none/waiting/closed, effectsUncertain:boolean; ?previousRunId:UUID, ?reason:RunReason |
| TurnSummary | turnId:UUID, currentRunId:UUID, state:running/waiting/completed/stopped/error/timeout, continuation:none/waiting/closed; ?reason:RunReason |
| PendingInput | namespace:Namespace, runId:UUID, turnId:UUID, data:InputRequestedData; data.b4 contains v, pausedGeneration, proposalHash, status and optional expiresAt/grant. For non-permission interrupts it may also carry responseSchema without changing the opaque application payload |
| Recovery checkpoint | checkpoint_id:UUID, namespace:Namespace; ?parent_checkpoint_id:UUID |
| Recovery revision | opaque immutable string identifying the selected head plus journal watermark; equality only, not a client-editable counter |
| History lineage | checkpointId:UUID, namespace:Namespace, fragmentIndex:uint; ?parentCheckpointId:UUID, ?sourceThreadId:UUID, ?sourceCheckpointId:UUID, ?originRunId:UUID |
| Retention | replaySeconds:uint, replayBytes:uint, oldestSeq:uint, latestSeq:uint, receiptSecondsAfterSettlement:uint; ?resultExpiresAt:RFC3339 |
| Receipt | submissionId:string, submissionKind:b4/agui, runId:UUID, turnId:UUID, acceptedAt:RFC3339, replayed:boolean, disposition:accepted/applied/not_applied; ?inputId:UUID, ?reason:string |

Activity runId/turnId are required for newly executed facts; historical copied
facts may omit runId and carry originRunId in their provenance payload instead.
The original grouping turnId can remain a historical ID without a destination
Run lookup. Preserve protected origin provenance in authorization and do not
fabricate a destination Run. Namespace values and original public message/tool/
plan/provider schemas are the same across live and recovered payloads.

Example initial B4 command (ordinary standard peers may omit metadata.b4):

```json
{"id":1,"method":"run.start","params":{"assistantId":"/chat#agent","input":{"messages":[{"role":"user","content":"Hello"}]},"metadata":{"b4":{"v":1,"submissionId":"f37747fe-5676-4c46-aa48-1ddfe7eaf410"}}}}
```

Example response with a closed standard result and extensible meta:

```json
{"type":"success","id":1,"result":{"runId":"871e7ea2-7a46-4678-bcac-3a912de1b008"},"meta":{"appliedThroughSeq":1,"b4":{"v":1,"receipt":{"submissionId":"f37747fe-5676-4c46-aa48-1ddfe7eaf410","submissionKind":"b4","runId":"871e7ea2-7a46-4678-bcac-3a912de1b008","turnId":"871e7ea2-7a46-4678-bcac-3a912de1b008","acceptedAt":"2026-11-05T12:00:00Z","replayed":false,"disposition":"accepted"}}}}
```

Example correlated standard lifecycle frame; correlation stays outside data:

```json
{"type":"event","eventId":"b4e1.0da04590-7139-4020-b6c0-de2c25b34f8c.2","seq":2,"method":"lifecycle","params":{"namespace":[],"timestamp":1793880000000,"data":{"event":"started","graphName":"chat"}},"b4":{"v":1,"generation":"0da04590-7139-4020-b6c0-de2c25b34f8c","runId":"871e7ea2-7a46-4678-bcac-3a912de1b008","turnId":"871e7ea2-7a46-4678-bcac-3a912de1b008"}}
```

Example single permission answer (grant text is an invalid illustrative placeholder,
not usable authority); a multi-prompt pause uses responses instead:

```json
{"id":2,"method":"input.respond","params":{"namespace":[],"interruptId":"permission-1","response":{"decision":"once","grant":"illustrative-opaque-token"},"metadata":{"b4":{"v":1,"submissionId":"2a59a6be-99e2-4f49-b8cc-2a742aa4982f","expected":{"generation":"0da04590-7139-4020-b6c0-de2c25b34f8c","runId":"871e7ea2-7a46-4678-bcac-3a912de1b008","pausedGeneration":"bd5026de-f7cb-4fe1-b8eb-cd4cb05d917f"}}}}}
```

Store approval remains its independently approved body
`{namespace,key,if_revision}` plus optional Idempotency-Key, not the Run receipt
carrier. Trace-only langsmithTracer is validated and honored where tracing is
configured or rejected explicitly before acceptance; it does not enable a
LangSmith wire dialect or change the submission's execution identity.

## 14. Approved v1 wire clarifications

Brian approved these four concrete type/key clarifications by replying “Continue”
to the reviewed proposal on 2026-11-06. The reviewed proposal SHA256 is
`93ba70dfa1e446aa52ea77b0dc6dd45f70337e679a7c0f462c46667291cbb3a1`.
They fill the gaps in sections 3, 8, 12 and 13 without changing existing operation
semantics, limits/defaults, resource paths, authorization, retention or source pins.

### History anchor

`history.anchor` is a required nonempty opaque string identifying the frozen
history selection. Clients store/compare it for equality and do not parse it
or treat it as authority. It remains stable while paging that selection, including
empty history. Clients send the existing checkpoint UUID or returned `b4h1.`
cursor in `before`; the anchor introduces no request member. `nextBefore` remains `null|string`; existing authorized cursor and
history-changed/history-expired rules apply. The selection follows the existing
generation/revision/branch/namespace scope; it creates no checkpoint or authority.
No equality guarantee is added across independently selected histories.

### Input disposition custom fact

For `custom` data named `b4.input`, use this payload:

```ts
{ v: 1; inputId: UUID; runId: UUID; turnId: UUID;
  disposition: "accepted" | "applied" | "not_applied"; reason?: string }
```

`runId` is the exact injection target, never a successor. The event's standard
namespace and top-level B4 correlation retain their existing meanings. Only the
already-approved durable transitions produce these dispositions. This payload
contains no grant, submission token, full receipt or injected message text.
Authorized exact receipt lookup remains the operation-reconciliation mechanism.
`reason` is a public, sanitized disposition explanation, not private diagnostics
or copied input. Unknown optional server extension fields remain preservable.

### Agent metadata schema and limit keys

`metadata.b4.schemas` is an extensible object with these known optional keys;
unsupported schema-bearing controls are omitted. A supported schema-bearing
control must publish its schema; an unknown schema prevents claiming support:

- `injectionInput`, `stateEdit`, `resumeUpdate`, `resumeGoto`, `resumeConfig`,
  `recovery`: JSON Schema objects for the named existing feature.
- `custom`: map of custom event name to JSON Schema object, including the existing
  reserved B4 custom facts where supported.

`metadata.b4.limits` is an extensible object. Values are effective maxima, never
remaining quota or a grant of support. Required common fields are
`requestBytes:uint` and `pendingPrompts:uint`. Known optional fields/groups are:

```ts
snapshotBytes?: uint; eventBytes?: uint;
inbox?: { entries: uint; bytes: uint; textBytes: uint };
viewer?: { events: uint; bytes: uint };
inspection?: {
  requestBytes: uint; responseBytes: uint;
  defaults: { maxEntries: uint; maxFileBytes: uint; maxTotalBytes: uint };
  caps: { maxEntries: uint; maxFileBytes: uint; maxTotalBytes: uint };
};
staging?: { uploadBytes: uint; quotaBytes: uint; deadlineMs: uint };
```

A present group has all its listed members. Each supported feature requires its
applicable group (`inbox` for injection, `viewer` for ASP observation, and the
corresponding inspection/staging groups); only unavailable features omit them.
Every enforced configured snapshot/event ceiling must be advertised in
`snapshotBytes`/`eventBytes`. An unknown required limit prevents a support claim;
omission never means unlimited capacity. Existing capability/schema guards
still control whether a feature is usable. Optional output fields represent genuinely inapplicable or unconfigured ceilings,
not uncertainty about an enforced ceiling. No new numeric defaults are chosen here. Use the already-approved 1 MiB request, 64 prompts, inbox128/1 MiB/
64 KiB text, viewer1024/4 MiB, inspection defaults/caps and effective configured
staging/output ceilings. Preserve unknown server extension fields.

### Webhook delivery summary

While an accepted webhook's bounded delivery record is retained, Run metadata
contains the summary below. It is omitted when no webhook was accepted or after
that delivery record expires under the approved retention rules:

```ts
webhook?: { state: "pending" | "delivered" | "failed"; attempts: uint }
```

This object has only these two members. Pending includes queued, in-flight and
backoff delivery; delivered means confirmed successful delivery; failed means
terminal failure/budget exhaustion under the approved policy. Attempts counts
durably started/reserved delivery attempts (0 through the existing maximum five),
including an in-flight attempt. Reserve/increment before network send so a crash
cannot create an uncounted retry. This is an attempt count, not a success count.
An absent webhook is represented by omission. Existing callback payload, at-least-
once semantics, retry budget, authority and refusal behavior stay in force.
