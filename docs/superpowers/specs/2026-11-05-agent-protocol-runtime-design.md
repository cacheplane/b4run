# B4 Agent Protocol runtime and persistence design

Date: 2026-11-05

Status: Approved by Brian on 2026-11-05 after independent specification review,
including the concrete coordination choices. No implementation or test pass is claimed.

Read with the wire design and approved Store design in this directory. Baseline
B4 source is `c1e1796556d0863da735e47822014bafa015ef3f`. The new runtime replaces
the old HTTP dialect in one release while retaining native AG-UI execution.

## 1. Components and trust boundaries

All bindings call one AdmissionService, ExecutionHost, PermissionService,
StateService and ProjectionService. Binding decoders preserve native IDs and
translate only transport/schema differences. They must not duplicate business
state machines, issue graph calls directly or grant permissions independently.

- AdmissionService resolves principal/route/provenance, validates input/config,
  resolves defaults, serializes the Thread generation and commits an operation.
- ExecutionHost owns durable dispatch, exact-run control/inbox delivery, deadlines,
  safe shutdown and actual-unwind tracking. Observer lifetime is separate.
- RuntimeStorage supplies transaction-scoped checkpoint/pending/grant/Run/receipt/
  journal/ownership operations under one authoritative backend.
- Adapter declares real message/state/injection/fork/edit capabilities and
  implements safe-boundary execution, checkpoint rebinding and interruption.
- ProjectionService materializes standard resources plus the declared recovery/
  activity metadata at a coherent journal watermark; transport hubs only wake
  readers and bound per-viewer delivery.
- StoreService and MemoryCoordinator implement their separate approved domain
  transactions. A tool's Store/filesystem/external write is not part of a runtime
  checkpoint transaction and is not undone by Run rollback.

Keep Node/host APIs outside the portable core. Existing execute-route-core,
permission/constraint checks, native translation and public activity types are
refactored into these responsibilities, not replaced by parallel runtimes.

## 2. Built-in stores and fresh runtime version

Local default is one SQLite database at
`.b4/agent-protocol/v1/runtime.sqlite`, WAL with durable transaction semantics,
opened by one execution-owner process. Store a version/installation UUID marker;
reject a newer/incompatible format before migrations or runtime writes. Use an
exclusive owner lock tied to process identity for the database lifetime. Opening
multiple worker replicas against this local file is configuration error, not
service-wide distributed ownership. Fail boot/readiness with a clear diagnostic.

Replicated Node uses shared Postgres: existing configured schema, default public,
with fresh default runtime table prefix `b4_ap_v1`. A RuntimeStorage factory
creates cooperating checkpoint/Thread/grant/Run/journal components sharing the
same pool and transaction context. Existing custom schema/prefix options remain
identifier-validated; an explicitly reused incompatible namespace fails before
DDL/write. Serialize schema installation under advisory locks and mark the
whole runtime schema version coherently. Do not rely on independent per-store
migration maxima or separate connection transactions for a single admission.

Logical durable entities are Thread generations/head revisions; Runs/results;
checkpoint ancestry/provenance/pending writes; paused generations/input records;
grant hashes/consumption; submissions/spent-token tombstones; ordered journal and
materialized projection; dispatch/injection/control inboxes; fenced leases;
maintenance/deletion jobs; native aliases; webhook delivery and retention work.
Physical table grouping is internal, but each entity has explicit identity and
transaction ownership. A checkpoint records canonical Run owner and namespace;
Run-associated data is never identified for deletion by timestamps alone.

Preserve `.b4/memory.sqlite`, generic Store data, `.b4/permissions.json`, workspaces,
source bundles, configuration and secrets under their existing scopes. Keep old
threads/checkpoints/grants/client-tool database files and Postgres tables intact
but outside the new live namespace. No importer, alias or automatic wipe. Retire
old owners before activating the new namespace; backup/cutover procedures live
in the release spec/runbook. These paths are implementation targets, not actions
performed during this design review.

Custom stores must implement the required transaction/fence/snapshot/delete/
copy hooks or a documented recoverable coordinator. Boot validates the declared
profile; operation validation rejects unsupported specific controls before abort,
grant consumption or partial writes. A custom checkpointer with only get/put
cannot truthfully advertise coordinated rollback or full crash-safe recovery.

## 3. Atomic acceptance and execution boundary

Initial submission transaction, after policy/schema preflight:

1. Resolve current caller authority for the target/receipt scope, then lock its
   operation namespace and look up an existing token before mutable-state checks.
2. Return an authorized exact token/fingerprint receipt using its original target/
   defaults, even when a successful resume already consumed its expected pause.
   Reject conflicts/spent/retired tokens. Only a genuinely new operation then
   verifies current Thread generation/head/Run/pause and active ownership.
3. Allocate one canonical Run UUID, stable turn root equal to it, and selected
   pre-run checkpoint; stamp owner/provenance/default cleanup/disconnect intent.
4. Append accepted/input facts, update Thread/projection, create result holder,
   durable dispatch row and optional callback intent, and save submission receipt.
5. Commit before acknowledgement or graph execution. Publication follows commit.

Resume transaction locks the exact paused generation, validates the complete
current answer set and every required grant/override, then atomically consumes
all selected grants, closes that pause, records pending decisions, allocates one
continuation Run linked to root/previous, updates projection/journal and creates
receipt/dispatch. A failure commits none of those changes. Different tokens
cannot win the same pause twice; exact accepted-token retries recover it.

The dispatcher conditionally changes accepted -> running and durably marks
startedAt/owner/fence before invoking any graph/model/tool hook. A crash after
that marker is uncertain, even if no tool actually ran. Never use "no checkpoint
was saved" as proof of no external effects. Started work is never automatically
replayed after lost ownership. Accepted work proven never started may dispatch
under the same Run after ownership recovery. Committed settlement wins over any
stale observer/worker error.

Existing app-wide remembered-rule stores may be outside the runtime transaction.
An Always answer writes a durable idempotent rule intent in the resume acceptance
transaction. Apply it to the existing configured scope before starting protected
execution; all framework writers use the same coordinator and existing deny/
constraint precedence. Retrying an unapplied intent uses the same operation/rule
identity; after application it is not reapplied because of ordinary Run recovery.
I/O failure leaves a recoverable accepted operation and cannot execute the action
under a claimed successfully remembered rule. Native Postgres permission storage
may enlist in the same transaction. Custom rule stores need idempotent/conditional
mutation or reject Always before acceptance; Once/Deny do not require an external
remembered-rule mutation. Never hold a database transaction across human input,
provider I/O or an external file write.

## 4. Ownership, dispatch and control

Postgres claims a durable Thread lease under row lock, with increasing fence,
60-second expiry and 15-second heartbeat by default. Include generation and
fence in every runtime checkpoint/pending/journal/projection write; verify the
current lease in the same transaction as the write. Use transaction-bound fenced
pool/context wrappers; a stale worker cannot persist by reusing an old SQL pool.
A notification is only a wakeup. Durable polling/reconciliation every second
keeps dispatch/control correctness when NOTIFY is missed or duplicated.

Before takeover, serialize/fence the old owner and classify durable started
state. Do not declare owner death from a disconnected observer or empty local
registry. Fencing stops stale runtime writes, not an already issued external
provider action. Mark a lost started Run error/execution_lost with effectsUncertain,
retain partial state and make that uncertainty visible. Explicit new user input
can start a fresh turn after reconciliation; it must never resume pending source
actions from the lost segment. The client must show this uncertainty before a
user deliberately repeats the intended action. No exactly-once external-effect
claim or implicit safe downgrade is made.

Non-owner API replicas enqueue authorized exact-run cancel/inject/control rows
under the same Thread lock. The owner polls/wakes and conditionally applies them.
wait=false means durable acceptance only. wait=true waits for actual adapter/
provider unwind and final state/cleanup; an HTTP wait timeout leaves the accepted
operation alive for resource reconciliation. No sticky sessions or mandatory
Redis. Scope service limits and expose explicit capacity failures before acceptance.

## 5. Outcomes, pauses and temporary cleanup

| Durable event | Run status/reason | Continuation |
| --- | --- | --- |
| accepted or executing | pending; phase accepted/running | none |
| ordinary completion | success/completed | closed |
| permission park | interrupted/permission | waiting with a durable paused generation |
| cooperative user stop | interrupted/user_stop | closed |
| execution-owning stream disconnect | interrupted/client_disconnect after actual unwind | closed |
| clean shutdown abort | interrupted/server_shutdown | closed |
| deadline reached | timeout/deadline | closed after clean unwind, or uncertain on forced loss |
| graph/tool execution failure | error/execution_error | closed |
| lost started owner | error/execution_lost, effectsUncertain=true | closed |

Paused prompts and eligibility are independent of the journal/receipt TTL.
Expired prompts remain visible; positive answers fail, bound negative abandonment
may proceed. Resume creates a new Run but not another top-level user turn.
Stopping a paused predecessor closes its continuation without executing the graph
or emitting another terminal native event. A losing late cancel cannot stop the
successor admitted by the winning resume. Settlement/journal/receipt and current
turn state are committed under the same Thread generation/fence.

Keep the binding's cleanup intent across ordinary ASP/native continuations.
Later REST creation re-evaluates its own explicit/omitted on_completion default
and atomically replaces intent. Keep temporary Thread state while waiting for
permission. Final success/error/timeout/stop plus actual unwind and inspection
lease release permits automatic cleanup; retain independent Run/results first
for seven days. A finalizer checks the generation/head/cleanup intent and cannot
erase a newly admitted successor. Explicit Thread DELETE instead cascades its
associated Runs/results as approved.

Execution-owning REST creation streams honor cancel-on-disconnect by default;
explicit continue uses the durable executor. Background POST acceptance owns no
observer lifetime. Passive Thread/Run observation closure only unsubscribes.
Native POST disconnect requests cancellation as before (reason client_disconnect); transport
handlers must route abort through the common executor instead of abandoning
untracked promises. Graceful shutdown closes admission, drains for configured
budget, then deliberately aborts and waits; a forced kill becomes execution_lost,
not an invented clean stop. Already parked durable waits remain after restart.

## 6. Active input and safe new turns after stop

Built-in conversational injection is applied before the next model step, after
any current model/tool invocation finishes. Persist ordered input IDs and exact
Run/namespace generation in the bounded inbox. The owner checkpoints accepted
messages and their applied disposition at one idempotent boundary before the
next model invocation. No concurrent invoke or out-of-band graph mutation.
A repeated token returns that same entry. If the Run parks/stops/finishes first,
mark remaining entries not_applied with reason and retain them for user recovery;
do not drain into a successor or supply a permission answer.

A checkpoint may still contain pending tool/interrupt tasks after a stop, lost
execution or source copy. The adapter's checkpoint-rebind hook creates a new
non-executing checkpoint revision for a fresh turn: retire old executable tasks
and their grants without invoking tools. Preserve original execution_lost and
effectsUncertain on both Run and affected activity. Mark a task not-executed only
with durable proof it never started; an issued/unknown external effect remains
uncertain even after its future continuation is retired. Copied historical
outcomes stay historical while destination authority is revoked. Fresh input
starts from this safe head,
not LangGraph's implicit interrupted-task continuation. If the adapter cannot
prove safe reconciliation, reject fresh execution with not_supported/unsafe_state
and offer an independent clean Thread. Never silently run the retired proposal.

State edits/overrides use declared public fields and reducers; the permission
proposal hash includes protected arguments/context. An edit changing that hash
rejects old approval rather than creating an invisible edit-and-approve flow.
Source scope/principal/handles/fences are never editable graph configuration.

## 7. State changes, copy, fork and rollback

PATCH state/messages creates a checkpoint revision with no Run/inference. Merge
values top-level through declared reducers; combine messages by stable ID,
append new IDs and replace authorized existing IDs in a new revision. Metadata
merges independently; checkpoint is ignored for metadata-only PATCH. Reject state/
message mutation while active execution, inspection or maintenance owns the
Thread. Active steering uses the inbox. All historical branches remain addressable
unless explicitly removed by the approved rollback/deletion scope.

Copy includes the full authorized checkpoint ancestry/history of the selected
coherent source view, not only values. Allocate new destination checkpoint UUIDs
once, persist source-to-copy mappings, retain message/tool activity IDs and
protected source lineage. No fabricated execution Runs. A copied historical
activity's Run identity is provenance, not a readable destination Run resource.
Stamp new ownership; evaluate inherited route/tenant provenance even if the
source Thread is later deleted. Copy neither usable grants/client-tool receipts
nor thread-local allow rules nor sandbox handles. Resolve a destination workspace
normally; required source file state needs supported reconstruction or rejection.

state.fork resolves checkpointId only within the authorized source Thread and
its exact stored namespace/graph provenance. Root forks are supported by the
built-in agent adapter; child forks need an explicit adapter namespace hook.
Create the destination/coherent copied ancestry and one accepted Run atomically
or via invisible prepared rows completed before acknowledgement. Return only
the pinned threadId/runId result. Optional input/config are validated before
creation. Absent input means adapter checkpoint continuation, with fresh destination
approval for any re-parked protected task; it never transfers source authority.
If an unresolved task cannot be safely rebound/re-parked without execution,
reject before exposing a destination. Source and destination locks are ordered
by UUID to avoid deadlock; active source reads require a coherent committed cut.

Rollback eligibility is the current head's Run: accepted/running, latest actionable
pause, or latest settled segment with no descendant execution/state edit/independent
branch depending on its writes. Older dependent targets return 409 rollback_conflict;
there is no cascade into successors. Validate rollback authority/backend hooks
before requesting abort. Record maintenance, stop and fully unwind, then remove
only target-owned checkpoints/pending writes/results/Run, restore its pre-run
head, close grants/prompts, invalidate affected projection and append a b4.history
fact. Keep the Thread busy until cleanup finishes; failure retains a recoverable
maintenance record rather than reports restoration. wait=true requires completion.

If restoration lands on an old protected proposal, retire its authority and use
the non-executing rebind hook to re-park with fresh generation/grants, or reject
rollback during preflight if unsupported. Allocate no execution Run to restore.
Retain earlier checkpoint ancestry, copies and branches. Workspace/Store/memory,
remembered rules and external effects are not undone. Keep spent-grant protection
and private retry tombstones even though ordinary Run GET/search returns absence.

## 8. Logical deletion and provider cleanup

Run DELETE requires finished and non-actionable state, no unwind/maintenance;
remove Run/result only, retaining checkpoint/display lineage needed by the Thread.
A root Run deletion does not break turn grouping. Thread DELETE requires no
active owner/inspection/mutation lease; caller explicitly stops/waits first.
In one transaction mark the generation inaccessible, retire inputs/aliases,
remove its resources and enqueue exclusively-owned provider teardown. 204 means
logical revocation/deletion committed, not physical erasure of backups/providers.
Other replicas immediately deny reads/replay; stale writes fail fences.

Provider cleanup is a durable idempotent retry job, visible to operators with
bounded redacted diagnostics. Retry with backoff up to a declared seven-day
operational escalation window; retain the obligation until resolved, not silently
abandon after that window. Release source references under their existing quota/
retention policy. Never recursively delete a shared app workspace or cascade
into generic Store/memory/independent copies. Custom backends must support the
required logical payload cleanup or refuse before mutation, not skip an optional
method and claim success.

## 9. Journal, materialization and retention

Assign seq under the same Thread lock/transaction that appends immutable facts.
Commit state/projection H with journal writes where possible; adapter checkpoint
writes are staged/enlisted so a public H cannot precede required checkpoint facts.
A crash before publication is recovered from committed journal data. Never mutate
or coalesce an already numbered record. Compact presentation independently.
Checkpoint state plus journal-derived partial activity are explicit separate
sources in the coherent snapshot. History fragments preserve their real checkpoint
anchor; one huge checkpoint's display history can be paged without fake revisions.

Read snapshot at H and register/tail >H without a lost-event gap, using database
watermark reads and replay-to-live transition. Filtering never renumbers or grants
authority. Authorization applies to each contributing namespace/route. Pending
prompts/current open activity and history coverage must fit advertised admission
bounds or fail explicitly, never truncate silently. Seq exhaustion refuses new
writes/admission before overflow; existing data becomes read-only until a new
explicit Thread is selected. Do not wrap or reset an existing generation's seq.

| Data | Initial default |
| --- | --- |
| Raw replay | 24 hours or 64 MiB/thread generation, whichever first; additional declared service quota |
| Thread state/checkpoint/compacted history and retained Runs/results | no TTL until explicit deletion |
| Settled temporary-thread independent Run/result | seven days after cleanup |
| Full settled submission receipt | seven days; unsettled obligations retained |
| Pending prompt | no implicit TTL; explicit grant/prompt expiry honored |
| Settled grant ledger | existing seven-day policy, never prune unresolved consumption obligations |

Prune raw payload only after required projection materialization. Store capacity
failure backpressures/fails explicitly; no silent conversation deletion to satisfy
replay quota. Expired history/replay triggers the wire resync policy. Rollback
appends an invalidation; old immutable facts are no longer served as current
history. Thread deletion removes replay payloads. Minimal deletion/consumption
facts are private and cannot recreate full public resources.

## 10. Host adapters, readiness and affected consumers

Full release reference is Node/Docker with ASP SSE/commands/WebSocket, native
SSE/protobuf, REST/Store and applicable extensions. Node HTTP upgrade wiring is
real work, not implied by existing createServer. Shared Postgres instances use
this same executor/control plane. Vercel/Fetch/Workers keep one portable core
with host-specific upgrade/lifetime adapters and durable stores; reject unsupported
background/continue/webhook before acceptance. Plain fetch exports, waitUntil and
a database WebSocket driver do not establish arbitrary execution lifetime.
Advertise only features proved in deployed gates; retain truthful reduced profiles.

Readiness checks the resolved runtime version/coordinator, required stores,
executor registration and required providers' runtime resource availability,
not model inference or credentials. Preserve request-scoped store disposal and
static edge import/bundle boundaries. Helm probes, shutdown handling and SPA
routing use the wire spec's reserved paths and separate health semantics.

Update CLI remote execution/thread commands, activity/native connector, chat,
memory, navlog and its narrow owner review proxy, code-fixer/software-factory
readers, generated app templates and all affected harnesses together. Preserve
workspace inspection's separate abortable lease and source staging's quota/
uploader gates. Store approval uses its approved domain coordinator, not a
transaction spanning tool side effects. Integration plans must map actual files
from the audited inventory and refresh them against implementation main before
edits; this spec does not authorize switching the dirty original checkout.
