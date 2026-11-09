# Agent Protocol P0 setup and execution map

Date: 2026-11-05. Scope: isolated setup, baseline qualification and verified plan
mapping only. No production source or wire/runtime contract change; C1 has not
started. Baseline commands below ran before the documentation-only setup commit.

## Pinned candidates and preserved originals

| Repository | Execution branch | Selected source | Documentation input head | Audit baseline |
| --- | --- | --- | --- | --- |
| B4 | `integration/agent-protocol-v1` | `c1e1796556d0863da735e47822014bafa015ef3f` | `791a30d756b79fecac56dcccc4bc36dcea439b09` | same as source |
| b4app | `implementation/agent-protocol-v1` | `a7e1ef743cebaf3704a3fa37ede72db8018df12d` | `fe6d81c380b4890031aeba5c7e81a662a440d7d2` | `e15c113d4d8d5fca17475b42f34cbef7914791d4` |

Execution roots are `/Users/blove/repos/b4run/.worktrees/agent-protocol-v1` and
`/Users/blove/repos/b4run/.worktrees/b4app-agent-protocol-v1`. Both were clean and
on the named branch before this setup worker began. The parent fetched current
main, freshly created and pinned these worktrees from the selected source SHAs,
and imported only the approved documentation before dispatch. This setup worker
reused those verified branches without fetching, switching, resetting or
recreating them. The original B4 checkout was
inspected on `blove/ag-ui-orchestration-projection` at
`f7d89dbc6588a12f7cb41f13d43cc8defa98b244`; original b4app was on `main` at
`52407063a9d44bd75889a176492e9f019e9d397a`. Their unrelated dirty files were
preserved. The first sandbox pnpm install briefly created original-root
`.pnpm-store/`: its birth time and sole project symlink matched that install and
the implementation worktree. After proving ownership, this worker unlinked only
that symlink and removed 517 empty directories with `rmdir`; no target was
traversed and no original data was removed. The before/after evidence is private
`empty-store-cleanup.json`. Worktree root AGENTS.md and applicable current CI instructions were
read; no nested contributor instructions apply to the edited documentation.

B4's source tree is `9e26d22b4b69bed7949f8a9cd359d1fe868a8182`;
b4app's is `0383afb278d727186988e6646f444f49def5d1ea`. The b4app audit-to-source
diff covers 153 files (9110 insertions, 2248 deletions), so the current execution
source, rather than the older audit tree, governs all existing behavior.

Normative pins remain Agent Protocol
`455acf2eb2c55c634350f4c6a8da117d0ecfa7b1` (OpenAPI 0.1.6 / CDDL 0.0.20) and
AG-UI `08eae9dc13546e91272efb2d0ef863e21acc6ee3`. P0 does not replace them.
The independent upstream download and byte verification are private setup
inputs; the committed C1 fixture manifest remains future work.

## Verified path and interface map

`git ls-tree -r --name-only HEAD` and scoped `rg` inventories were used against
both candidates. New files/tests marked Create remain new; their absence is
expected. Short existing basenames resolve within the component below, rather
than to a second newly created implementation. The private machine-readable
inventory records each backticked Files reference and its existing candidates.

| Plan/tasks | Verified current destinations and ownership |
| --- | --- |
| C1–C5 | Existing formatter owner `packages/config-biome/biome.json` must receive the future exact-file formatter exception for verbatim upstream OpenAPI; no exception is implemented in P0. Existing SDK source/exports in `packages/sdk/src/`, scripts in `packages/sdk/scripts/`; CLI message/catalog/validation composition in `packages/cli/src/lib/dev/protocol/` is new. Existing route identity and normalization files are in `packages/cli/src/lib/runtime/`. |
| R1–R3 | New SDK `agent-protocol/storage.ts` and backend `src/runtime/` bundles. Existing SQLite `src/internal/db.ts`; Postgres `src/schema.ts`, `src/internal/{tx,fenced-pool}.ts`, `src/options.ts`, `src/index.ts` all exist. |
| R4–R12 | New services under `packages/cli/src/lib/dev/protocol/runtime/`. Existing admission, registry, permissions and serve orchestration are in `packages/cli/src/lib/dev/`; execute-route-core/server are in `packages/cli/src/lib/runtime/`. Both `dev/pending-interrupts.ts` and `runtime/pending-interrupts.ts` exist and must retain their separate responsibilities. |
| B1–B4 | New routes/transports under `packages/cli/src/lib/dev/protocol/`; existing `runtime-fetch-core.ts`, `runtime-fetch-handler.ts`, `runtime-server.ts`, `node-web-adapter.ts` are in `packages/cli/src/lib/dev/`. |
| B5 | `packages/cli/src/lib/dev/{agui-handler,agui-capabilities}.ts`; `packages/ag-ui/src/client.ts`, `src/copilotkit-runtime/createB4AgentRunner.ts`, `src/view/resume.ts`. |
| B6 | Existing `dev/thread-workspace-http.ts`, `runtime/{workspace-protocol,managed-workspace-manager,edge-capability-report}.ts`, `build/targets/{web-runtime,vercel-config}.ts` under CLI `src/lib/`; chart files exist as planned. |
| B7 | Existing CLI `src/commands/{run,threads}.ts` and `src/lib/threads/{attach-state,sse-frames,tail-stream,tail-render}.ts`; code-fixer consumer scripts and runtime test exist; software-factory worker client/wire/SSE/workspace reader exist. |
| S1–S3 | Memory files resolve under `packages/memory/src/`; pgvector queries/schema/store under `packages/memory-pgvector/src/`. New generic Store adapters live under each durable backend's `src/store/`. |
| S4 | Existing writer call sites: `packages/core/src/capabilities/built-in/memory.ts`, CLI `src/commands/memory.ts` and `src/lib/dev/memory-handler.ts`; Inspector `app/api/memory/[id]/{approve,reject,forget}/route.ts` and `src/store/resolve.ts`. The only Inspector production `approveWithReconcile` call is the approve route; `packages/inspector/e2e/helpers.ts` is test helper context. |
| S5–S6 | New Store HTTP service/routes under CLI protocol directory. Navlog `web/app/api/b4/[...path]/route.ts`, `web/app/lib/{memory-candidates,use-memory-candidates}.ts` and matching `packages/devkit/templates/app-navlog/web` copies exist. |
| L1–L6 | Current docs/nav/SEO and release files named in the release plan exist. L3 extends existing `apps/web/app/vercel-ignore-build.test.ts` through `pnpm --filter @b4run/web test vercel-ignore-build`; the planned new scripts/*.test.mjs would duplicate its current shell-script regression ownership and is removed from the mapping. Qualification files/runbook are new. Use the current root scripts; do not resurrect retired publish/upload/backfill commands or add a release owner. |
| A1–A7/A9 | Existing B4 client files stay under `Sources/B4Adapter/`; Swift normalized adapter interface is `Sources/WorkspaceProtocol/Adapter.swift`; business writer is `Sources/Coordinator/SessionService.swift`. Storage and mirror owners remain as current AGENTS.md specifies. |
| A8 | Removed `NewThreadSheet.swift` / `PhoneNewThreadSheet.swift` map to `Sources/WorkspaceUI/NewThread/{NewThreadView,NewThreadDock,NewThreadDraft,NewThreadMemory,StartOptions,ComposerPickerRow}.swift` and `Sources/WorkspaceUI/PhoneProjectSheet.swift`. Current regression files are `Tests/WorkspaceUITests/{NewThreadDraftTests,PhoneProjectTests}.swift` alongside ConnectionsModelTests. |

Additional concrete consumer destinations discovered by `rg` for B7/L1 are
`examples/navlog/web/app/lib/{proxy-allowlist,thread-access}.ts` and their tests;
`packages/devkit/templates/app-navlog/web/app/lib/proxy-allowlist.ts`;
`examples/software-factory/controller/src/lib/client.ts` and
`src/app/work-orders/cancel/index.ts`; `examples/chat/web/app/api/copilotkit/[...path]/route.ts`;
Navlog's matching CopilotKit route and scaffold copy; CLI `src/fetch-exports.ts`,
`src/runtime-exports.ts`, `src/lib/runtime-routes.ts`,
`src/lib/runtime/static-modules-core.ts` and `src/lib/dev/parked-route.ts`.
Review these existing call sites when their binding changes; do not independently
implement protocol admission inside consumers.

The parent also verified a C1 tooling collision by running Biome formatting via
stdin only: original pinned OpenAPI is 77,595 bytes, formatter output 77,367.
Root lint checks `test/`, so C1 must modify existing formatter owner
`packages/config-biome/biome.json` with a narrow formatter-only exception for
`test/agent-protocol/fixtures/upstream/openapi.json`. Hand-authored fixtures,
scripts and other applicable checks stay enabled. C1 also preserves verbatim upstream LICENSE bytes as an explicit sixth
fixture/provenance file. P0 updates only this ownership
map: no formatter configuration, upstream fixture or source file was changed.

The current SDK `BackendAdapter` has only `kind`, `execute(entry,input,{signal})`
and `stream(entry,input,{signal})`. LangGraph's adapter invokes a function or
`invoke(input,{signal})`; its stream currently yields the execution result.
LangChain's agent adapter owns checkpoint-aware agent materialization and stream
projection, with middleware in `agent-middleware.ts`. Safe-boundary hooks are new
implementation work, not capabilities proved by P0. The R8/R10 Modify map now
explicitly names the existing `packages/sdk/src/backend-adapter.ts` contract
owner and provider adapters; it does not add a hook shape or a second interface. Swift's `AgentAdapter` has
inspect/create/load/send/interrupt/respond/reconcile/events/dispose/delete;
`NewSessionInput` and `TurnInput` already carry model, permission and additional
directories. Preserve these newer fields for Codex/Claude when adding B4 behavior.

## Current b4app behavior and migration collisions

- D-182 removed the cross-thread directory lock. Preserve per-thread `turn_active`
  and runtime-outage checks; never restore `directory_locked` or removed
  `activeHarnessTurns`. The A5 plan instruction is corrected accordingly.
- D-183 owns first-message `thread.start`, runtime model/permission selection,
  project-folder attachment and title generation. Adapt the current composer;
  do not restore removed sheets or overwrite its behavior.
- D-185 routes implicit SessionService publication through
  `WorkspaceDatabase.withVisibleThread` in `Sources/WorkspaceStorage/ThreadDeletes.swift`.
  Preserve advisory-lock-before-row-lease ordering and the non-suspending,
  nonreentrant EventLog callback after the projection commit. Keep its existing
  real-Postgres visibility and deletion-race tests.
- Existing local migrations run through `0009_thread_runtime_choice.sql`; hub
  migrations through `0017_thread_runtime_choice.sql`. Proposed Agent Protocol
  migrations are now `Sources/WorkspaceStorage/SQL/0010_agent_protocol.sql` and
  `Hub/crates/b4hub-db/migrations/0018_agent_protocol.sql`. Recheck allocation at
  creation, preserve applied SQL and frozen hashes, and retain registry's separate
  0001/0002 namespace. MirrorSchema.swift defines the SQLite ordered migrations,
  currently through version 6 (runtime choices); A4 appends version 7 after a
  collision recheck. MirrorMigrations.swift applies the array through
  `PRAGMA user_version` and preserves rebuild/prepare behavior. This internal
  schema number is separate from client protocol v2.

Both client-plan copies are byte-identical after this mapping-only update. The
approved client spec copies are unchanged and byte-identical.

## Toolchain and baseline gates

Host: macOS 26.5, native arm64 Node (no Rosetta). Installed toolchain: Node 24.20.0 (meets `>=24.0.0`; source CI pins 24.17.0); pnpm 10.33.0 (root packageManager pin);
Xcode 26.6 (17F113); Swift 6.3.3; XcodeGen 2.46.0; Rust/Cargo 1.93.1;
actionlint 1.7.12; ShellCheck 0.11.0; Bats 1.14.0. PostgreSQL fetch pins 17.11.0
and verifies archive SHA256 before extraction. Swift Package.resolved and Cargo
--locked are retained. Commands run from repository roots; root Rust invocations
use `cargo +1.93.1 --manifest-path Hub/Cargo.toml ...` because root invocation
does not discover the nested Hub/rust-toolchain.toml.

B4 `pnpm install --frozen-lockfile` passed (15s reported); manifests/lockfile
were unchanged. `pnpm ci:validate` failed with exit 1 after approximately 1887.60s
of wall time from log creation to final output, within the source CI lane's
45-minute budget. Release integrity passed 34 tests (411.68ms reported); lint
passed (31 Turbo tasks, 8.69s); build-cache check passed; full build passed
(29 Turbo tasks, 51.622s); typecheck passed (59 Turbo tasks, 11.537s).

The source Vitest aggregate was **3 failed / 1008 passed / 31 skipped files**
(1042 total), and **4 failed / 12867 passed / 385 skipped tests** (13256 total),
in **1776.72s**. The original failed assertions are retained:

| Existing test | Exact baseline failure |
| --- | --- |
| `test/k8s-compat/assert-docker-smoke.test.ts:2901` — deliberate stdout-holding orphan | `expected 6660 to be less than 5000` for `closeElapsedMs` |
| `packages/cli/test/vercel-target.test.ts:916` — composed static/assets/function/routes | `Test timed out in 5000ms` |
| `packages/cli/test/vercel-target.test.ts:1019` — unbundleable extra function preserves output | `Test timed out in 5000ms` |
| `packages/sandbox/test/bounded-filesystem.test.ts:92` — batch real-shell byte reads | `Test timed out in 5000ms` |

The test wrapper still ran its additional Node safety/demo lanes after Vitest
(2 / 180 / 9 tests passed respectively, zero failures);
the `&&` validation chain then stopped before release-inventory and subsequent
gates. Initial B4 validation overlapped the initial Swift/Xcode/Clippy compiles.
This is a possible contributor to timing failures, not a proven root cause.
No checked-in source, assertion, timeout, worker policy or production behavior was changed.
The unchanged-source focused rerun used `--maxWorkers=1`, the same workspace
configuration, three original files and a test-name filter. It selected the four
original cases plus the identically named Kube batch-read sibling: **5 selected
tests**, not four. It failed in **29.72s**: **2 failed / 1 passed files**, **4 failed /
1 passed / 231 filter-skipped tests** (236 in those files). Both Vercel 5000ms
timeouts and the Docker batch-read 5000ms timeout reproduced; the additional Kube
batch-read case also timed out at 5000ms. The orphan case passed on this rerun.
That nonreproduction does not fix or erase its aggregate failure. No other heavy
build/test lane ran during the focused rerun. Disk had 765 GiB available.

The three reproduced original cases prevent attributing the failures solely to
initial build concurrency. The real-shell test reads 605 files and the Vercel
cases perform multiple real local builds; host/toolchain duration sensitivity is
plausible, but P0 has not established the root cause. No weaker-green diagnostic
run was used. The complete aggregate remains failed; independent downstream
results do not make it green.

After receiving the aggregate and focused evidence, the user explicitly chose
**“Continue protocol work; keep baseline failures open”**. This authorizes
protocol implementation after P0's required spec/quality reviews while retaining
these baseline failures as open release-qualification items. This does not fix
the baseline or establish a green result, and does not waive final
release-qualification gates or authorize production publication.
C1 has not started in this setup task.

### Selected-source CI context (parent read-only evidence)

The parent independently inspected CI for the exact selected sources. B4
`c1e1796556d0863da735e47822014bafa015ef3f`, [CI run 41390348488](https://github.com/cacheplane/b4run/actions/runs/41390348488) on 2026-11-02,
succeeded: source 26m, release-controller 17m38s, harness 16m02s, pack 3m38s,
browser 1m11s, aggregate validate success. Evidence is private
`b4-selected-main-ci-run.json` (head binding) and
`b4-selected-main-ci-jobs.jsonl` (job outcomes/durations). These existing-main results do not substitute
for the new integration candidate's gates or erase the local failures above.

For b4app `a7e1ef743cebaf3704a3fa37ede72db8018df12d`, [CI run 42144407683](https://github.com/cacheplane/b4app/actions/runs/42144407683), app
builds, Rust and lint succeeded, but the **package job failed**:
`ThreadOpenRequestTests.a_missing_notification_thread_has_a_bounded_honest_failure`
caught `timed out waiting for open timeout` at line 91. Its Swift aggregate was
1411 tests / 170 suites / 1 issue in 164.333s. The parent saved
`b4app-selected-main-ci-run.json` (head binding) and
`logs/b4app-selected-main-ci-failure.log`. The selected app source therefore has
no clean all-lanes CI result in this evidence. Local Swift outcome is recorded
separately below.

### Independent local downstream gates

The independent release-controller run also hit an existing baseline timing
failure: `interruptions before and after every recovery mutation resume without
duplicate publication` reached its unchanged 1,200,000ms parent-test timeout
(1,200,003.50ms reported). Its source defines 32 effects × before/after = 64
subtests, concurrency 2, with a 120,000ms timeout for each child. Effects 1–29
before/after completed passing; the six effect 30/31/32 before/after subtests
were cancelled because their parent did not finish. The full controller lane
exited 1 in **1581.99s**, within its 30-minute CI budget: **4184 tests / 24 suites,
4176 passed / 1 failed / 7 cancelled / 0 skipped**. The seven cancellations are
the timeout parent and its six unfinished children.

The separate failure was `scripts/release/test/smoke-process-runner.test.mjs:406`,
“command shim cannot spawn the requested process until the controller opens its
gate”: at line 439 it expected `{ code: 0, signal: null }` and observed
`{ code: 1, signal: null }`. This fail-closed assertion has not been explained
by the recovery timeout. Its unchanged focused reproduction/diagnostic outcome
is recorded below. No loop, timeout or assertion was changed. The user's
continuation authorization retains the recovery timeout and this separate,
unclassified shim assertion as open qualification failures; passing early
effects do not prove the uncompleted cases.

The unchanged command-shim focused case subsequently passed **1/1** in
296.55ms (157.14ms case duration). The original aggregate assertion remains
unresolved; the possible asynchronous empty-gate publication race is a
hypothesis only. No observer run, source fix, assertion change or retry loop
followed the nonreproduction.

The initial full harness had framework **120 passed / 1 failed / 1 pending of
122 tests**, 33 suites, in 393.328s; its failure was the missing Chromium
prerequisite at `run-generated-navlog-activation.test.ts:1499`. Runtime passed
**17 / 18 tests** (1 pending), 8 suites, in 245.604s; smoke passed **3 / 3** in
91.225s. The initial full harness command exited 1. Complete per-lane reports
and transcripts were copied to private `harness-initial/`.

The repository's locked Playwright **1.62.1** Chromium build **1234** (Chrome for
Testing **151.0.7922.34**) was then installed and its executable verified. The
first installation was interrupted during headless-shell download to apply the
supported `PLAYWRIGHT_SKIP_BROWSER_GC=1` cache-preservation setting; installation
logs contain no browser-removal action. The completion install passed without
package/lock changes. This resolves the setup prerequisite only.

The complete unchanged framework rerun still exited 1 in **699.856s**:
**120 passed / 1 failed / 1 pending of 122 tests**, 33 suites. The Navlog lifecycle
advanced to a functional **AG-UI HTTP 409** failure: `request_error`,
`details.code=malformed_checkpoint`, “Pending checkpoint interrupts cannot be
addressed safely.” It was the third recorded AG-UI response, after two HTTP 200
responses with 41 and 5 events. No Workbench screenshot was produced and no
browser success is claimed. Fixture command/AG-UI evidence is preserved in
private `framework-navlog-failure/`; rerun JSON/transcripts are under
`framework-rerun/`. This remains an open native-compatibility qualification item
for R6/R8/B5/B7/L4; no source fix or further rerun was performed.

The first private Hub setup wrapper did not invoke Cargo: system Bash
**3.2.57** returned from `source <(test-db.sh)` before the helper's export arrived,
and the required-DATABASE_URL assertion failed immediately. A harmless delayed
fixture reproduced `unset` from the same Bash process-substitution pattern.
The helper had initialized only the worktree/task-specific private cluster; it
was stopped with that helper and the same task TMPDIR. This was a setup failure,
not a Rust test result. The client-plan command now uses a sequential private
mode-0600 env-file handoff and clears inherited DATABASE_URL. Its EXIT cleanup
attempts both private-cluster stop and env-file removal even if one fails, while
preserving the original test failure status. Its actual Cargo
suite outcome is recorded below; no source or assertion was changed.

All other independent B4 downstream gates passed: `pnpm check:release-inventory`,
`pnpm test:sync-chart-appversion`, `node scripts/check-docs.mjs`, `pnpm pack:check`,
`pnpm verify:typescript-tooling-pack` and `pnpm verify:harness:self-test`. Their
exact commands, exit codes and wall timestamps are in `b4-post-baselines.json`;
full output is in the corresponding `logs/b4-*.log` files. These passes do not
change the failed source/controller/framework results above.

### Native local baseline and cleanup

| Command/lane | Actual result |
| --- | --- |
| `Scripts/fetch-postgres.sh` | Passed; PostgreSQL 17.11.0 archive matches pinned SHA256. |
| `swift format lint --strict --recursive Sources Tests Apps Package.swift` | Passed. |
| `swift build` | Passed; build reported 124.22s. Initial sandbox module-cache denial was resolved by authorized escalation. |
| `swift test` | Passed **1411 tests / 170 suites**, **94.496s** test duration (197.147s command wall including test build). The selected-source CI ThreadOpenRequest failure did not reproduce locally; it is not fixed by P0. A SwiftNIO teardown diagnostic remains in the full log. |
| Rust fmt / Clippy | Passed using pinned **1.93.1**; Clippy reported 73s. Root PATH-stable rustfmt absence was a setup invocation issue, resolved by selecting the existing pinned toolchain. |
| Actual `cargo +1.93.1 test --workspace --locked` from scoped Hub subprocess | Passed **497 tests**, **29 result groups**, **0 failed / ignored / filtered**, **291.373s** command wall. No Cargo tests ran in the earlier failed process-substitution setup attempt. |
| Generated unsigned CI app builds | All **4 passed**: local macOS/iOS and beta macOS/iOS; the generated project and DerivedData are uncommitted outputs. |
| `Scripts/test-ios-layout.sh` | Passed **25 / 25**, **0 failed / skipped** on a newly created task-only iOS 26.5 iPhone 17 Pro simulator. Xcode observer reported **970.123s** (1003.467s command wall). Repeated LLDB-version metadata diagnostics did not become test failures. |
| Current auxiliary CI checks | actionlint, ShellCheck, tag guard (**10** cases), deploy Bats (**64**), Scripts Bats (**5**), fixture-bind Python (**2**) and docs-index (**174 decisions / 91 verification records**) all passed. The initial sandbox socket denial was resolved by authorized escalation. |

Full native outcomes/commands are in `remaining-baselines.json`,
`hub-corrected-baseline.json`, `cargo-test-counts.json`,
`baseline-command-outcomes.json` and `auxiliary-baselines.json`. Logs are
`logs/b4app-test.log`, `b4app-hub-test-corrected.log`, `b4app-*-build.log`,
`b4app-ios-layout.log` and the named prerequisite/auxiliary logs. The layout
result bundle is the uncommitted app-worktree `.build/iOSLayout/P0-20261105.xcresult`
with its machine-readable `.summary.json`.

The task-only simulator was deleted and its UUID absence verified. Cleanup's
shutdown attempt reported it was already Shutdown; deletion still completed.
The private Hub cluster was stopped (`pg_ctl: no server running` verified), and
the unique mode-0600 env file was removed. Its inherited DATABASE_URL was cleared
and the exact task-worktree helper loopback endpoint was verified before Cargo;
no URL/envfile contents were printed. No task sessions remain running.

The initial sandbox DNS/install/cache/socket failures and the Bash handoff issue
were resolved setup problems. The B4 source/controller/framework failures remain
open under the user's continuation decision. Local `ci:validate` excludes the
separate CI dependency-security/browser job; Windows, gated Docker/Kubernetes,
real-provider/remote/physical-device and production lanes were not performed in
P0 and are not recorded as passes. Their dedicated infrastructure or explicit
later qualification scope remains required where applicable.

Final verification checks source/lock/migration hashes, explicit documentation
scope, plan/spec byte identity, whitespace and current docs gates. P0 changes
only the contracts/runtime/release/client plan mapping and this setup report;
no production source, test assertions, package/lock files or normative upstream
pins were changed. Parent spec and quality review are still required before C1.

## Private evidence and hashes

The unified machine-readable result index is `p0-summary.json`.
Full command output, path inventories and baseline JSON live under
`/private/tmp/b4-ap-implementation-20261105/`; logs are in `logs/`, source manifest
in `candidate-source-baseline.json`, path matches in `plan-path-inventory.json`,
and actual workspace package names/scripts in `workspace-package-scripts.json`.
`toolchain-binary-hashes.json` records resolved executable/shim hashes, including
the actual pinned Rust 1.93.1 compiler and Cargo executables as well as PATH
proxy provenance. Command outcomes are in `baseline-command-outcomes.json`,
`b4-post-baselines.json`, `auxiliary-baselines.json` and `remaining-baselines.json`.
`migration-baseline-hashes.json` preserves SHA256 for 30 existing local/registry/
hub migration and mirror schema/application files.
The manifest records SHA256 of both root instructions/CI definitions, B4 package
manifest/lock/workspace files, and Swift/Rust manifests/locks/toolchain/Postgres
fetch script. The parent independently downloaded/verified the immutable
upstream inputs in `upstream-verified/verification.json`; this worker read those
verification results. These are setup inputs, not a packed/released candidate
manifest.

| Input | Baseline SHA256 |
| --- | --- |
| Upstream LICENSE input (parent independent verification) | `d9bb52f2e3540d60ff50d8f0f5b6ba649b7fd346948c4c3d086c8afb120763c7` |
| Upstream OpenAPI input (parent independent verification) | `7d069e43ca105e8127ce07ba7bd8bd7a78a2fadd6420009f2634a24cfb153f32` |
| Upstream CDDL input (parent independent verification) | `9cebafc02e523f509f880aa8ebaa2af077f8a7f0589d8063a50d610c3af78fb1` |
| B4 pnpm-lock.yaml | `949fecab847862c4acc8c7881922d96482c5797543974e110e3a2eef3c62ba59` |
| B4 package.json | `b559c728e0b19f2a4e51d4aa873862746d043b7f7542618def6f742e6421c0f9` |
| b4app Package.resolved | `2ccd523e0a9073145aa6b835a1fe00b252ba476b19c24851c9c355ca481d0ce1` |
| b4app Hub/Cargo.lock | `65d55eb6525b292f0509e445fb8647dc93b3e832270c4001443ed852cc0a7837` |
| Downloaded PostgreSQL 17.11.0 archive (matches script pin) | `a1c2786acb0c398f9b2d76806fc52f5dc8b222cbc8e9383a9b9702084daaf3a5` |
| b4app Scripts/fetch-postgres.sh | `60b78332b3a6520354ae0ac845dade833a4f9b592d7ed8e1b07ccea646f1037d` |

No provider live gate, production deploy, real-account command, credential dump,
existing owner .b4 data or shared-worktree Postgres cluster is part of P0. No
fixture/build result is evidence of a real provider or physical-device integration.
