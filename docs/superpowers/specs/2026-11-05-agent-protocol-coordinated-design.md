# Coordinated B4 and b4app Agent Protocol design

Date: 2026-11-05

Status: Approved by Brian on 2026-11-05 after independent specification review.
Approval includes the concrete wire names, coordination interfaces and client
activation choices in the linked specifications. No runtime implementation, live conformance result,
publication, project upgrade or data deletion is claimed. Independent wire,
runtime and client/release reviews approved these drafts after corrections; see
the [review record](../reports/2026-11-05-agent-protocol-spec-review.md). Brian
subsequently approved the written specifications.

B4 replaces its older HTTP dialect with the pinned Agent Protocol resources and
streaming protocol, preserving native AG-UI and current application functionality.
The release contains 27 standard operations and six explicitly declared extension
operations. b4app adopts the shared standard contract, full negotiated B4 behavior
and a generic conversational baseline. There is no legacy endpoint/client stack,
compatibility alias, migration API or automated transcript conversion.

## 1. Review map and ownership

| Specification | Responsibility |
| --- | --- |
| [Wire contract](2026-11-05-agent-protocol-wire-design.md) | Source pins/correction overlay; exact capability/metadata/receipt/prompt/recovery names; standard and native bindings, errors and payloads |
| [Runtime and persistence](2026-11-05-agent-protocol-runtime-design.md) | Atomic admission, checkpoint/grant/journal ownership, execution and stop/resume/injection/branch/deletion/retention/host behavior |
| [Store and memory review](2026-11-05-agent-protocol-store-design.md) | Already approved standalone Store CRUD, managed projection, revisions, cross-writer approval and client guarantees; unchanged by this consolidation |
| [b4app client](2026-11-05-b4app-agent-protocol-design.md) | Connection/auth fields, durable projection/operation ledger, permission UX, old-data retention and Mac/hub/phone activation |
| This document | Cross-repo boundaries, policy traceability, release/docs/acceptance requirements and review decisions |

The client spec is committed separately in an isolated b4app worktree at its
canonical docs/superpowers/specs path; this directory contains its identical
review copy. Shared wire definitions are owned by B4, not independently generated
from examples in two repos. Implementation plans must package/pin the corresponding
schema/fixture corpus and verify copied-fixture hashes; a second independent
source of wire truth is prohibited. None of these specs authorizes implementing
a component before Brian approves the written design.

Source audit baselines: B4 `c1e1796556d0863da735e47822014bafa015ef3f`; b4app
`e15c113d4d8d5fca17475b42f34cbef7914791d4`; Agent Protocol
`455acf2eb2c55c634350f4c6a8da117d0ecfa7b1` (OpenAPI 0.1.6/CDDL 0.0.20);
AG-UI `08eae9dc13546e91272efb2d0ef863e21acc6ee3` (1.0).
Refreshing implementation files against later main requires a recorded diff,
not silently changing normative protocol pins or discarding unrelated work.

## 2. Architecture and dependency boundaries

The portable shared runtime owns admission, execution identity, permission and
state mutations. REST/ASP and native AG-UI are bindings over it. Durable ordered
facts and a compacted coherent recovery projection preserve activity/functionality
formerly exposed by /turns and /events. Standard Thread GET/history carry the
recovery metadata; no new bootstrap command/endpoint is introduced. Runtime-
internal ownership/receipts/grants never become ordinary Store documents.

Full Node/Docker is the reference: single-owner SQLite by default; shared
Postgres, fenced execution and durable control/dispatch for replicas, without
mandatory Redis. Serverless/Fetch uses actual host upgrade/execution-lifetime
adapters and advertises only deployed-verified capabilities. Native AG-UI retains
valid SSE/protobuf and all runnable kinds' actual capabilities. Store memory
stays in its authoritative domain backend, with transactional review shared by
HTTP, CLI and runtime writers.

The owner Mac coordinator is b4app's sole local projection writer. It atomically
saves applied events plus cursor, durable partial output and private action
obligations. UI/hub/phone consume permitted committed presentation and route
intent through that owner. Endpoint secrets, grants, dispatch ledgers and raw
recovery internals are not mirrored. Generic mode does not require B4 metadata,
health or native endpoints and cannot claim B4's receipt/recovery guarantees.

These components support separate implementation plans: contract/fixtures,
runtime/storage, bindings/consumers, Store (approved design), client/sync and
release/docs qualification. Dependency contracts must settle before overlapping
work; this is design decomposition, not a task-by-task build plan.

## 3. Approved concrete choices

Behavioral approvals remain intact. These concrete resolutions are now explicit:

1. Reverse-domain `run.b4.*` capabilities and reserved `metadata.b4`/legal
   Event/ResponseMeta.b4 v1 envelopes. Closed CDDL results/data remain closed.
2. One generation/monotonic seq/eventId scheme, coherent Thread recovery,
   history cursor/fragments, explicit resync/errors and coverage-bounded activity.
3. Shared fresh runtime database namespace, transaction-scoped store context,
   durable dispatch/control, fenced Postgres leases and safe checkpoint rebinding.
4. Exact native arbitrary-string alias scope and duplicate POST response with
   canonical correlation, retaining ordinary native compatibility without a
   stream re-entry invention.
5. Service quotas and callback payload/retry policy for the upstream webhook
   field that the older dialect ignored; honest reduced-host rejection.
6. b4app's new agentProtocol kind and protocol-v2 activation, preventing old
   mirrors from receiving unknown enum values or unsafe permission controls.

These concrete choices were approved in the written-spec review. Changing a behavior-level
promise during implementation requires returning to that decision; routine
internal naming does not permit changing the public contract.

## 4. Approved policy traceability

| Approved decision | Concrete home |
| --- | --- |
| Pinned contract/corrections; 27 standard plus six extensions | Wire 1-2, 10-12 |
| Disconnect/missing-thread/completion/duplicate/mechanical defaults | Wire 5; Runtime 3, 5 |
| Per-segment UUID and stable root user turn | Wire 4, 6, 13; Runtime 3; Client 4-5 |
| Complete permission answers, decisions/grants and negative expiry abandonment | Wire 7; Runtime 3, 5; Client 6 |
| Exact active/paused stop and no successor cancellation | Runtime 4-6; Client 5 |
| Durable receipts, token conflicts, unknown effects | Wire 6, 11; Runtime 3-4; Client 5 |
| Controlled overrides and active injection | Wire 6-7; Runtime 6 |
| Rollback, PATCH, copy/fork, explicit Run/Thread deletion | Runtime 7-8; Wire 8, 11 |
| Journal, coherent standard-resource recovery and retention | Wire 8, 13; Runtime 9; Client 4, 6 |
| All-kind Agent catalog, default selection and native discovery | Wire 3, 9 |
| Generic Store and managed-memory review | Approved Store spec |
| Temporary-thread cleanup through permission continuation | Runtime 5 |
| Node/SQLite/Postgres and truthful host profiles | Runtime 2, 4, 10 |
| Generic baseline plus B4, LangSmith binding deferred | Client 1 |
| Immutable connection identity/explicit auth/secret sync exclusions | Client 2-3 |
| Durable coordinator projection and no offline queue | Client 4-6 |
| Fresh runtime plus retained old storage/cached history | Runtime 2; Client 3 |
| Integration branch, packed candidates and ordered release | This document 5 |
| 0.x fixed-group patch, exact pins and independent versions | This document 6 |
| Release acceptance gates | This document 8 |
| Current guidance/historical posts/conformance claims | This document 7 |

## 5. Integration, cutover and partial publication

Use small reviewed B4 topic PRs into one integration branch and a matching b4app
branch. Keep public main coherent until the complete replacement is ready. Work
from isolated pinned worktrees, leaving the dirty original checkouts untouched.
Test immutable packed candidate inventories/checksums with isolated consumer
installation and exact dependencies; workspace imports supplement but do not
replace packed consumer tests. Do not assume a public npm next lane: the inspected
publisher targets latest and requires main-reachable exact release candidates.
A new prerelease lane would need separate controller/provenance review.

Before final integration, review the website preview and prepare a production
promotion hold that does not disable previews. Verify actual Vercel project
settings at release time; its production build configuration does not wait for
npm publication. Preserve /app/, association/pairing and download surfaces.
Rebuild/retest the actual merged/versioned candidate where its identity differs
from the tested integration head. Required controller/inventory/content pins and
evidence remain intact; do not bypass publication authority to shorten a window.

Prepare the matching app/site artifacts before public publication. Publish/audit
the complete B4 fixed group with existing tooling, verify registry artifacts and
the matching b4app against them, then make the reviewed site/app distribution
available under their recorded gates. Ship required hub schema/protocol support
before dependent clients; protocol-v2 feature activation waits for matching Mac/
phone availability. Joined scopes block new-protocol features until verified
activation; never-joined scopes must require v2 before a later join/upload.
Unrelated existing sync is not filtered away or stalled. This is an ordered
window, not atomic multi-service publish.
State exact version labels while promotions are in progress; do not advertise
an unavailable app download or an unpublished B4 contract as released.

For each upgraded project, record old/new pins and owners, consistent backups,
old admission drain/stop and actual unwind, preserved old store locations and
fresh namespace selection. Include the live-check project and inventoried attached
projects deliberately upgraded; app installation does not rewrite every user
repository. Never leave older replicas executing the same application through
cutover or infer their exit from a new namespace/observer reconnect. New app
historical retirement is not proof of old external-effect cancellation.

If a stage fails, hold dependent promotion and reconcile through the existing
controller/release process. Record partial registry/site/app states and exact
forward-fix/hold decision; do not erase or republish different bytes under a
version. Retained old state is not automatic downgrade support for new history.
The eventual runbook must enumerate actual project/deployment/storage paths,
commands and operator preconditions from the implementation revision, without
assuming a live SQLite main-file copy is a complete WAL backup.

## 6. Version and compatibility policy

Use the existing 0.x patch Changeset fixed-group policy, all 21 packages at one
exact coordinated version, chosen from audited registry/release state at release
preparation. Do not reserve 0.15.9/0.16.0 from the old baseline or implicitly
request Changesets minor (documented as a real 1.0 transition). Label the HTTP/
client change breaking prominently; compliance alone is not 1.0-wide stability.

Use exact pins/lockfiles in coordinated templates/examples/test projects. Existing
caret ranges can admit a breaking patch; tell users to retain pins until an
intentional cutover, without claiming control of their unlocked installations.
b4app/hub/charts retain independent version sequences and tested minimums.
B4 chart appVersion follows normal synchronization. Publish exact B4 extension/
client/hub profile versions and supported capabilities; a product version alone
is not proof of compatibility. Generic mode requires no B4 version marker.

## 7. Current and historical documentation

Update current API/config/permission/Store/workspace/deployment/CLI guides,
examples/scaffold READMEs, blueprints, website claims, author AGENTS template,
llms.txt, navigation and SEO together. Regenerate CLI docs from website MDX/nav
through the normal build, not a second authored reference. Regenerate SEO lastmod
with the prescribed content-commit sequence; preserve article publication dates.
Reconcile existing unreleased text with the actual new contract, including old
turns/events promises. Review rendering/links, machine-readable output and source
gate claims against the final acceptance record.

Preserve dated blog bodies/code/dates and historical changelogs/decisions/test
records. Add brief targeted version notices to misleading old API examples,
linking current guidance and naming covered versions; reuse an existing version
note where present. Append new release/upgrade entries and new b4app decisions/
gate records superseding old rules, never rewriting historical test results or
reformatting its owner-maintained roadmap. Obtain numbered decisions at PR time.

Current claims name pinned OpenAPI/CDDL/corrections, native AG-UI and tested host
profiles; distinguish B4 metadata/custom events/six extra operations. Do not call
Store approval upstream-standard, native HttpAgent recovery automatic, arbitrary
peers compatible or LangSmith a tested binding. No claim of upstream certification.
Document retention/resync/unknown execution effects and unsupported-host errors,
not waits/sockets as guarantees of durable arbitrary-lifetime execution.
The upgrade entry names removed endpoints/defaults, exact pins, client minimums,
fresh storage, retained history and cutover steps; it promises no migration tool,
legacy alias or wipe that the design does not provide.

## 8. Release acceptance and evidence

| Gate | Required release evidence |
| --- | --- |
| Both repository baselines | Current required CI/contributor commands; B4 source/controller/pack/tooling/harness/browser, Changesets and required CopilotKit/Vercel release lanes; b4app formatting/Swift/tests/macOS/iOS/beta builds, workflow/docs-index and locked Rust/shared fixtures |
| Standard/native wire | Independently pinned schema and overlay fixtures; real HTTP/ASP SSE/commands/WebSocket; all 27 operations and six extensions, exact defaults/errors, absent old dialect/SPA fallthrough; actual supported native AG-UI/CopilotKit clients plus protobuf |
| Lifecycle/permission faults | Real controlled effect counters for complete grants/overrides, stop/resume races, defaults, receipts, injection, rollback/copy/fork/PATCH/delete and no successor cancellation/false outcomes |
| Persistence/recovery | SQLite process restart/exclusivity and two-process Postgres ownership/fence/control tests; commit/ack/publication/projection crashes, partial output, snapshot/history/filter/generation/expiry races, prompt retention, budgets and bounded slow viewers |
| Store/data preservation | Approved Store conformance and cross-writer collision/revision/receipt tests on actual applicable backends; untouched old runtime fixtures, preserved memory/workspace/config and historical app rows/drafts/outcomes |
| Examples/scaffolds/generic mode | Candidate packed install and affected chat/memory/navlog/code-fixer/software-factory/recipes/templates; strict generic fixtures omit every B4 extra; mock and actual runtime/consumer integration evidence distinguished |
| App/coordinator/phone | Actual isolated local DB/coordinator/CLI, focused settings/chat/permission/Stop/history UI, lost ack/restarts/auth/key rotation, grant-free sync/relay/first-answer/offline behavior, v1/v2 activation and retirement; relevant Codex/Claude shared-code regression coverage |
| Live and delivery | Real model-backed local B4 plus authenticated remote HTTPS reference with streaming/permissions/reconnect/cancel and real remote WebSocket; packaged target-Mac and changed physical-phone flows; affected chart/probe/shutdown/apply and advertised host deployments; published integrity/provenance/controller checks and final site/download/association/install verification |

The full Node SQLite/Postgres reference is mandatory. Environment-gated tests
needed for its new functionality must actually run for release; an absent secret
or infrastructure leaves a gate blocked, not passed/not-applicable. Existing
required Vercel/CopilotKit lanes remain required. Additional Fetch/Workers claims
need deployed evidence for their advertised features; honest reduced profiles
may reject unsupported background/continue/webhook before acceptance. Unrelated
optional providers do not all become prerequisites merely by existing.

Use deterministic model/tool fixtures in CI for races/side-effect assertions and
real runtime/consumer integration. Opt-in real provider/Keychain/target-Mac/device
checks stay outside ordinary b4app CI; builds/simulators cannot certify those
boundaries. Keep its A01-A18 baseline and record the newly exercised B4/local/
remote/permission/Stop/restart/auth/secret/packaging rows. Old 0.15.8 smoke or
fixture HTTPS is not evidence of new live conformance. Do not force paid allowance
exhaustion or unrelated sign-in merely to validate an unchanged error UI.

Each record states exact SHA/artifact/build/host/profile, command/scenario,
passed/failed/blocked/not-applicable reason and evidence path. Required prepublish
gates pass before publication. Registry/install/site checks happen when the
artifact really exists and block dependent promotion on failure. Declare the
coordinated release finished only after all mandatory postpublication checks.
Affected fixes rerun affected qualification plus required final CI; avoid an
unbounded benchmark program or claiming exactly-once external side effects.

## 9. Review boundary and next artifact

Brian approved this linked written design after independent review. The Store
spec retains its earlier approval. Write dependency-ordered implementation plans
per component/repo
with exact files/tests and release checkpoints. Do not implement or publish from
this design turn. Source inspection and documentation validation are explicitly
separate from the future release acceptance results above.
