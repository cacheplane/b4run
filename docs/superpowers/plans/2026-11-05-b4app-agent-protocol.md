# b4app Agent Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy B4 client with standard Agent Protocol and negotiated B4 recovery while preserving cached history and owner-device execution.

**Architecture:** Foundation transport/DTOs stay in the existing B4Adapter module; a generic projector and B4 extension projector feed one Coordinator-owned durable transaction. New profiles use agentProtocol kind, protocol-v2 sync activation and owner-private credentials/grants. No legacy HTTP fallback, LangSmith dialect or new memory UI.

**Tech Stack:** Swift/Foundation/URLSession, private PostgreSQL, SQLite iOS mirror, Rust hub, Swift Testing, existing fake runtimes and opt-in live gates.

---

**Spec:** approved `docs/superpowers/specs/2026-11-05-b4app-agent-protocol-design.md`.
**Shared dependency:** B4 C2 schema/corpus hash; full integration waits for B1–B6 and the matching packed runtime. This plan's review copy lives in B4; canonical execution destination is b4app. Use an isolated b4app implementation worktree and preserve the original checkout.

## File and migration map

P0 execution mapping and baseline evidence are recorded in B4's
`docs/superpowers/reports/2026-11-05-agent-protocol-p0-setup.md`. The approved
wire/runtime contracts and upstream pins are unchanged.

Create `Sources/B4Adapter/AgentProtocol{Types,Client,Events,Projection}.swift`,
`B4RecoveryProjection.swift`; retain `SSEParser.swift` with correct id handling.
Replace callers of B4HTTPClient/B4Protocol/B4Events/B4TurnTranslator; remove their
legacy implementations after the final new-adapter switch, not keep two stacks.
Module naming is internal; no new Swift target is required.

Create `Sources/WorkspaceStorage/AgentProtocol.swift`,
`Sources/Coordinator/ProtocolProjection.swift`, `ProtocolOperations.swift`,
`ProtocolActivation.swift`; preserve SessionService as sole business writer.
P0 selected source `a7e1ef743cebaf3704a3fa37ede72db8018df12d` already contains
`Sources/WorkspaceStorage/SQL/0009_thread_runtime_choice.sql` and
`Hub/crates/b4hub-db/migrations/0017_thread_runtime_choice.sql`. Allocate
`Sources/WorkspaceStorage/SQL/0010_agent_protocol.sql` and
`Hub/crates/b4hub-db/migrations/0018_agent_protocol.sql`; recheck for collisions
before creation. This renumbers only the audited plan's proposed 0009/0017 files.
Do not edit existing migrations or ship a changed migration hash.
`Sources/WorkspaceMirror/MirrorSchema.swift` currently ends its ordered
`PRAGMA user_version` migrations at version 6 (runtime choices). A4 appends
version 7 after rechecking allocation; `MirrorMigrations.swift` applies that
existing array and owns rebuild/prepare behavior. Preserve versions 1–6. This
internal SQLite schema number is separate from negotiated client protocol v2.

Tests run from b4app root. Rust commands use its Cargo workspace/private test DB.
P0 reproduced system Bash 3.2 returning from `source <(...)` before a delayed
export arrived; use a sequential mode-0600 temporary-file handoff instead:

```bash
bash <<'B4APP_HUB_TEST'
set -euo pipefail
unset DATABASE_URL
cd Hub
hub_test_env=$(mktemp)
hub_test_cleanup() {
  hub_test_status=$?
  trap - EXIT
  set +e
  ./scripts/test-db.sh --stop
  hub_stop_status=$?
  rm -f "$hub_test_env"
  hub_remove_status=$?
  if [ "$hub_test_status" -ne 0 ]; then exit "$hub_test_status"; fi
  if [ "$hub_stop_status" -ne 0 ]; then exit "$hub_stop_status"; fi
  exit "$hub_remove_status"
}
trap hub_test_cleanup EXIT
chmod 600 "$hub_test_env"
./scripts/test-db.sh > "$hub_test_env"
source "$hub_test_env"
: "${DATABASE_URL:?private cluster unavailable}"
cargo test --workspace --locked
B4APP_HUB_TEST
```

Run one cargo test per worktree; stop only that helper's cluster. Never print the
env file, inherit an account/shared-worktree DATABASE_URL, or point tests at the
owner's real account database/runtime directories. Real provider tests stay opt-in.

### A1: Pin shared wire corpus and compile new DTOs

**Files:** Create AgentProtocolTypes.swift, `Tests/B4AdapterTests/AgentProtocolTypesTests.swift`, `Fixtures/agent-protocol/manifest.json` and copied JSON corpus; modify `Package.swift` resources only if required.

- [ ] Import the exact SDK schema/corpus JSON from C2's built/packed artifacts; store original source/package/schema/corpus hashes. Add a deterministic refresh command to the task log; never transcribe fixture fields independently.
- [ ] Write decoding tests for standard resources, closed results, B4 v1 envelopes, native arbitrary token strings, unknown optional blocks and unsupported B4 major version. Test casing and error location explicitly.
- [ ] Run `swift test --filter AgentProtocolTypesTests`; expect missing DTO/decoder failures.
- [ ] Implement Foundation-only Codable types preserving arbitrary JSON, typed UUID IDs and B4 enums. Distinguish REST roles from ASP roles and command correlation ID from submission token. Keep unknown optional extensions opaque, not false or malformed.
- [ ] Run focused tests and `swift build`; verify copied corpus hashes match the B4 candidate manifest and no AppKit/NIO/storage import enters protocol transport.
- [ ] Commit `feat: decode pinned Agent Protocol and B4 contracts`.

### A2: Implement shared HTTP/SSE/WebSocket transport and explicit auth

**Files:** Create AgentProtocolClient.swift, AgentProtocolEvents.swift; modify SSEParser.swift; create `Tests/B4AdapterTests/AgentProtocolTransportTests.swift`; extend FakeB4Server.swift for standard-only requests.

- [ ] Test base prefixes on one origin, URL/ID escaping, all explicit auth modes, redirects, CRLF/reserved headers, split/Unicode SSE frames, eventId/seq and real WebSocket handshake/commands. Assert generic discovery never calls B4 health/native routes.
- [ ] Run `swift test --filter AgentProtocolTransportTests`; prove origin-only/implicit-auth/old-path assumptions fail.
- [ ] Implement immutable conservative normalized base URL, same deployment confinement, HTTPS/loopback policy and explicit none/bearer/header auth via lazy SecretStore reference. Disable cookies and refuse redirects across all transports.
- [ ] Add REST resources, SSE observation, command requests and shared WebSocket decode. Preserve HTTP errors versus correlated ASP errors; no dialect retry, automatic billing/auth switch or new-session fallback.
- [ ] Run focused tests plus actual local test-listener upgrades; inspect redacted error output for synthetic credential sentinels. No header value appears in arguments/results/UI state/logs.
- [ ] Commit `feat: transport standard protocol with scoped credentials`.

### A3: Add new profile fields and preserve old conversations

**Files:** Modify `Sources/WorkspaceProtocol/Domain.swift`, `Commands.swift`, `Sources/WorkspaceStorage/Rows.swift`, `Migrator.swift`, `Export.swift`; create local migration above, AgentProtocol.swift and `Tests/WorkspaceStorageTests/AgentProtocolMigrationTests.swift`.

- [ ] Build a copy-only old fixture with connections/turns/items/drafts/projects/read markers and unknown outcomes. Test exact field retention, legacy b4 local read-only interpretation, no old nativeScope rewrite and fresh profile identity.
- [ ] Run `swift test --filter AgentProtocolMigrationTests`; expect missing new-kind/storage support.
- [ ] Add agentProtocol kind and approved fields. Make schema backup from a quiesced scope before mutation, extend archive coverage for new owner-private obligations and keep endpoint secret values excluded. Add ordinary compatibility defaults without turning legacy data into live protocol identities.
- [ ] Persist retirement fields only after A4's verified v2 boundary for joined scopes; local legacy read-only behavior derives from kind immediately. No old pending-answer/send/delete-retry path can create an adapter or target the new server.
- [ ] Run migration/restore tests and existing conversation/remote-apply/thread-delete tests. Assert no credential reset, historical outcome fabrication or Codex/Claude row changes.
- [ ] Commit `feat: store protocol profiles while retaining historical B4 data`.

### A4: Gate hub/mirror activation without consuming deferred changes

**Files:** Create ProtocolActivation.swift and hub `Hub/crates/b4hub-db/migrations/0018_agent_protocol.sql`; modify `Hub/crates/b4hub-core/src/change.rs`, `writable.rs`, `Hub/crates/b4hub-db/src/{settings,changes,snapshot}.rs`, `Hub/crates/b4hub/src/{routes,serve}.rs`, `routes/{changes,snapshot}.rs`, `relay/link.rs`, `Sources/Coordinator/HubSync/{SyncFilter,HubSync,HubPull,HubLink}.swift`, `Sources/WorkspaceMirror/{MirrorSchema,MirrorMigrations,MirrorSync,MirrorTransport}.swift`, `Sources/WorkspaceSync/HubLinkConnection.swift`, `Sources/WorkspaceSync/HTTPHubAPI.swift`, `HubAPI.swift`, `Wire.swift` and `Tests/Fixtures/sync/changes.json`/relay fixtures.

- [ ] Test joined-v1 creation/admission refusal, immediate local legacy retirement without mirrored writes, unrelated Codex/Claude sync through restart, v2 activation then one normal retirement transaction, never-joined local data refusing v1 join and already-open pull/link fencing.
- [ ] Run `swift test --filter ProtocolActivationTests` after creating `Tests/CoordinatorTests/ProtocolActivationTests.swift`; run Rust fixtures/private-DB suite with the command above. Expect missing HTTP protocol gates and unknown-kind fixture failures.
- [ ] Install additive schema/support but withhold new-kind writes in joined scopes until active minClientProtocol=2 is verified through hub readyz. Persist account-bound activation; later temporary hub outage uses normal sync, not a new dispatch queue.
- [ ] Extend header/minimum enforcement to authenticated feeds/snapshots/push and relay, including open connections at activation. Add shared allowed fields and phone schema together; never treat permissive header acceptance as active-v2 proof.
- [ ] Explicitly exclude target/authReference/localServerId/auth mode/header and all private operation/grant/cursor tables. Never use SyncFilter nil as deferral, hold the global prefix or upload orphan children. Run Swift/Rust shared fixtures, old/new mixed-version and secret sentinel tests.
- [ ] Commit `feat: activate protocol profiles safely across hub and mirror`. Leave production minClientProtocol unchanged until the reviewed release checkpoint.

### A5: Atomically apply projection and cursor

**Files:** Create ProtocolProjection.swift and storage AgentProtocol.swift methods; modify SessionService.swift, `Sources/WorkspaceProtocol/Events.swift`, `Sources/Coordinator/EventLog.swift`; create `Tests/CoordinatorTests/ProtocolProjectionTests.swift`, `Tests/WorkspaceStorageTests/ProtocolProjectionStoreTests.swift`.

- [ ] Test crash before/after local commit, duplicate text/usage, namespace item collisions, receipt/event arrival order, unrelated imported root and stale-generation event and account-scope switch/logout. Assert viewer event is never published for an uncommitted batch.
- [ ] Run `swift test --filter ProtocolProjection`; expect current volatile streamed map/separate writes to fail.
- [ ] Implement one DB transaction for partial blocks/activity, Run/root associations, sanitized requests, private grants and applied cursor/coverage. Keep immutable intent/canonical correlation records separate from synced presentation rows.
- [ ] Route Agent Protocol events through this transaction. Missing initial correlation stages canonical IDs then reconciles receipt/Run; never attaches to activeTurn as a fallback. Publish only after commit and stop advancing on write failure.
- [ ] Run focused tests and existing SessionTests; preserve process-bound Codex/Claude request expiration and the current per-thread `turn_active` refusal. D-182 removed the directory lock; do not reintroduce it. Preserve D-185's `withVisibleThread` publication fence after the projection commit. Keep viewer EventLog epoch/sequence independent of ASP and sync cursors.
- [ ] Commit `feat: persist protocol projection and replay progress together`.

Contract assertion:

```swift
let before = try db.protocolCursor(threadId: thread.id)
storeFault.failNextProjectionCommit()
await projector.apply(batch)
#expect(try db.protocolCursor(threadId: thread.id) == before)
#expect(await viewer.eventsFor(batch).isEmpty)
```

The test fault is an internal dependency of the storage transaction; it is not
a new command/API or a fake alternate persistence implementation.

### A6: Thread creation, outgoing operations and receipt reconciliation

**Files:** Create ProtocolOperations.swift; modify B4Adapter.swift, B4Inspector.swift, SessionService.swift, `Sources/Coordinator/Router.swift`; create `Tests/B4AdapterTests/AgentProtocolSubmissionTests.swift`, `Tests/CoordinatorTests/ProtocolOperationTests.swift`.

- [ ] Test client UUID/do_nothing creation, atomic optimistic row+intent, lost ack before/after acceptance, original token replay, conflict/expired/gone/no-match and generic uncertainty. Include RunSearch exact literal selectors and fork/injection shared-Run receipts even without a new UI for those controls.
- [ ] Run `swift test --filter ProtocolOperation` and `swift test --filter AgentProtocolSubmissionTests`; expect old ordinal/nativeTurn logic to fail.
- [ ] Send standard commands over passive observation. Persist immutable online operation intent before dispatch and acknowledgement/Run identity before reporting accepted. No owner/server-offline turn queue or blind startup dispatch.
- [ ] Reconcile through explicit b4.submissionId/kind/operationThreadId/targetRunId selectors, Run metadata lookup and current snapshots. Keep empty/expired results unknown rather than invent failure/success or mint another token. Generic peers get only advertised guarantees.
- [ ] Run focused tests and relay/SessionService tests; two user retries must retain one optimistic item/turn and one admitted Run root. Stop uses the exact current segment UUID, never root/predecessor/current-thread substitution.
- [ ] Commit `feat: reconcile protocol submissions by durable identity`.

### A7: Snapshot/history/replay and permissions after restart

**Files:** Create AgentProtocolProjection.swift, B4RecoveryProjection.swift; modify B4Adapter.swift, SessionService.swift, `Sources/WorkspaceProtocol/Adapter.swift`; create `Tests/B4AdapterTests/AgentProtocolRecoveryTests.swift`, `Tests/CoordinatorTests/ProtocolPermissionTests.swift`.

- [ ] Test H hydration/live race, history anchor/fragments versus later events, widened filter coverage, rollback/deletion no-resurrection, partial output through restart, complete pending sets beyond replay TTL and effect uncertainty preservation.
- [ ] Run `swift test --filter AgentProtocolRecoveryTests` and `swift test --filter ProtocolPermissionTests`; no B4 snapshot/cursor is required in strict generic fixtures.
- [ ] Atomically install covered B4 snapshot/cursor; preserve preferences/drafts/unresolved intents and already loaded older history. Follow since/generation and pinned history anchors; explicit resync repeats recovery instead of jumping.
- [ ] Restore/revalidate current B4 prompts after restart rather than expire them from adapterGeneration alone. Persist answer drafts against exact proposal/pause/namespace; submit a complete set, keep raw grants owner-private and resolve only from server facts/receipt. Unknown generic schema is visible/cannot-answer.
- [ ] Run focused tests with Mac/phone competing answers, changed proposal, expired positive/negative abandonment, uncertain response receipt and credential rotation/denied access. Cached positive decisions never authorize a new generation.
- [ ] Commit `feat: recover protocol history and pending permissions safely`.

### A8: Settings, managed servers and permission presentation

**Files:** Modify `Sources/WorkspaceUI/{ConnectionSheets,ConnectionsView,WorkspaceModel+Connections,RuntimeRequestView,TranscriptView,PhoneProjectSheet}.swift`, `Sources/WorkspaceUI/NewThread/{NewThreadView,NewThreadDock,NewThreadDraft,NewThreadMemory,StartOptions,ComposerPickerRow}.swift`, `Sources/Coordinator/{B4ProjectInspector,LocalServerService}.swift`; create `Sources/Coordinator/B4ManagedServerProbe.swift`; update `Tests/WorkspaceUITests/{ConnectionsModelTests,NewThreadDraftTests,PhoneProjectTests}.swift`, `Tests/CoordinatorTests/LocalServerTests.swift`. The removed NewThreadSheet/PhoneNewThreadSheet paths map to this current composer/project flow; preserve D-183's first-message `thread.start`, runtime model/permission selection and project-folder behavior.

- [ ] Test catalog/schema chat filtering, immutable target/profile/agent edits, explicit auth entry/reference lifecycle, retired history state and partial/uncertain activity. Use focused model/UI tests, not trivial rendering snapshots.
- [ ] Run `swift test --filter ConnectionsModelTests` and `swift test --filter LocalServerTests`; expect typed-route/old-kind assumptions to fail.
- [ ] Wire the catalog picker, explicit auth modes and secure entry clearing. Preserve managed project ownership/source versus dev launch, local-server process identity and current project sync; use a B4-only liveness/readiness probe outside generic peer discovery.
- [ ] Present current eligible decisions and distinct Stop/abandon controls; no grant enters UI state or synced payload. Explain retired/unknown/stale states and block actions until current authorization is re-established.
- [ ] Run focused tests and macOS/iOS builds. Ensure new profile code does not start a retired server merely to open history or kill an attached server on observer disconnect.
- [ ] Commit `feat: expose standard protocol profiles and safe recovery UI`.

### A9: Replace fixtures and close cross-language regressions

**Files:** Rewrite `Tests/B4AdapterTests/Fixtures/fake-b4.py`, `fake-b4-cli.py`; update FakeB4Project.swift, existing adapter/session/delete/translator tests; create strict generic fixture and standard-only request ledger tests. Remove unused legacy B4Protocol/B4Events/B4TurnTranslator/B4HTTPClient implementations after all callers move.

- [ ] Make the fake server reject every retired path and implement the pinned standard schema plus only explicitly selected B4 extras. Generic mode fixture omits health/native/B4 metadata entirely. Count actual submitted operations/effects.
- [ ] Run full `swift test`; identify old-dialect test assumptions rather than relax new assertions to keep them passing.
- [ ] Port all affected tests to stable Run/root identities, command envelopes, receipt lookup, full pending sets and proper public Message blocks. Preserve raw framing, grant-free sync and secret-redaction fixtures shared with Rust.
- [ ] Run `swift format lint --strict --recursive Sources Tests Apps Package.swift`, `swift build`, `swift test` and locked Rust fmt/clippy/private DB tests. Verify collected/skipped counts and unrelated adapters' regression behavior.
- [ ] Build generated local/prod-equivalent and beta macOS/iOS targets with the existing CI commands, including phone mirror. No fixture success is recorded as a real remote/physical-device integration.
- [ ] Commit `test: qualify standard protocol client and mirror contracts`.

### A10: Real candidate qualification and decision records

**Files:** Update B4LiveTests.swift, `docs/compatibility.md`, `docs/milestones.md`; create new decision/gate files through the repo docs-index allocation rules. Do not edit historical D-019/020/021/023 or reformat the owner roadmap.

- [ ] Run the matching packed B4 from the cross-repo candidate manifest in isolated runtime/data directories; use real provider-backed local and authenticated remote HTTPS targets only in the opt-in gate.
- [ ] Exercise GUI/CLI streaming, rich activity, permission once/always/deny, active/paused Stop, continuation, lost acknowledgement, stream/server/coordinator restart, key rotation, history retirement and generic-mode limits.
- [ ] Exercise the actual packaged target Mac and changed physical-phone flows with staged v2 hub; record safe v1 refusal and activation before changing production settings. Keep grant/secret sentinels absent from viewer/sync/diagnostic output.
- [ ] Record exact SHAs/package hashes/build/client/hub/schema/host versions and performed/blocked cases. Re-run affected Codex/Claude shared-coordinator regressions without forcing unrelated paid/sign-in scenarios.
- [ ] Allocate decision numbers at PR time with `Scripts/docs-index.sh --next`, append superseding entries and run `Scripts/docs-index.sh --check`. Preserve original gate records; simulator or build-only evidence is labeled separately.
- [ ] Commit `docs: record protocol client compatibility and qualification`. Publication/production activation follows the separate coordinated release checkpoint.

## Exit checkpoint

No old HTTP/event dialect remains in the active client. Owner-local projection,
receipt/grant/recovery invariants and strict generic baseline pass automated
checks. Required live/packaged/device checks are recorded honestly; any missing
mandatory gate stays open. Commit the canonical client plan/spec in b4app and
keep the B4 review copy/schema-corpus hash aligned.
