# Cooperative Stop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. One fresh implementer owns this cohesive vertical feature, then fresh SPEC and independent QUALITY reviewers. Steps use checkbox syntax. The user already requested implementation, PR, and merge on green; do not ask for that authorization again.

**Goal:** Finish current LangGraph work on ordinary Stop, retain thread ownership
through state settlement, and prevent the next turn from replaying old actions.

**Architecture:** Separate registry soft-stop and hard-abort signals, forward
the soft signal through every production adapter path, and link it to native
RunControl. Preserve one canonical run slot and one settled outcome through AP
and AG-UI. Retire native future tasks nonexecutingly before a stopped thread is
used for fresh input. Unmodified dependencies; no new HTTP routes or tool factory.

**Tech Stack:** Node 24, pnpm 10.33.0, TypeScript NodeNext, Vitest, existing
LangGraph 1.4.17/Core 1.2.18, real SQLite/checkpointer fixtures, native AG-UI.

**Spec:** `docs/superpowers/specs/2026-11-08-cooperative-stop-design.md`.

---

## Workspace and isolation

Root for every command: `/Users/blove/repos/b4run/.worktrees/cooperative-stop-20261108`.
Branch `feat/cooperative-stop-20261108` is checked out at initial base
`0cd99fed50e325ef5b84b91adceca562cdffd09a`. Preserve the original repository's
unrelated dirty files and the separate `protocol/runtime-storage` worktree.
No resetting, copying its 79 uncommitted R8 files, or activating its 48 unmerged
protocol commits. Parent owns plans/bookkeeping; implementer owns feature code.

Private logs and process records: `/private/tmp/b4-cooperative-stop-20261108`.
Use login:false and require_escalated upfront for Node/process/SQLite/network/git
commands. Silently remove live provider credentials, database targets, and gated
test flags from local test environment. Do not print secrets, run live providers,
publish packages, cancel unrelated CI/release runs, or globally kill/prune
resources. Record exact own process/session exits and close test stores/sandboxes.

Setup completed with locked install. Clean main baseline `pnpm build` passed
29/29 tasks. Focused CLI baseline passed 83 tests with six infrastructure-gated
skips. LangChain baseline is recorded separately. Earlier protocol-branch
failures are not this branch's baseline exceptions.

## File responsibilities

- `packages/sdk/src/backend-adapter.ts` and `runtime-context.ts`: optional
  cooperative stop context distinct from existing hard signal, without Node or
  LangGraph imports. Add a small dependency-free internal stop outcome helper
  and package export only if needed to share classification across packages;
  do not add a new public author factory or broad root export inventory.
- `packages/langchain/src/cooperative-stop.ts` (new): native control/listener
  lifetime and recognition of actual drain outcome; no singleton modification.
- `packages/langchain/src/agent-adapter.ts`: materialized and raw agent paths,
  invoke/stream config, checkpoint-write settlement, stopped-head handling.
- `packages/langchain/src/chain-adapter.ts`: observable invocation boundary;
  pass control for graph-backed entries and preserve ordinary receiver/call form.
- `packages/langchain/src/agent-middleware.ts`, `subagent-tool-bridge.ts`,
  `tool-converter.ts`: propagate native/owned cooperative control exceptions,
  never turn them into successful/error ToolMessages or error episodes.
- `packages/langgraph/src/langgraph-adapter.ts`: native graph control with
  optional peers loaded only when needed; honest callable workflow boundary.
- `apps/web/app/components/docs/api-reference.ts`, the generated API reference
  tables, and `packages/cli/test/api-reference-compatibility.test.ts`: honestly
  classify only LangGraph root purity as not-claimed while preserving edge-safe
  runtime and strict dependency-free define-entry/route-module subpaths. Add an
  exact allowed root dependency/input boundary and retain every platform guard.
- `packages/langgraph/test/ui-packed-consumer.test.ts`: execute packed callable
  graph/workflow adapters without optional native peers, including soft pre-stop
  and owned outcome; test laziness rather than merely claiming it.
- `packages/cli/src/lib/dev/run-registry.ts`: separate stop signal and hard
  signal, idempotent exact claims, release/listener cleanup.
- `packages/cli/src/lib/dev/runtime-fetch-core.ts`: forward new handle fields
  through request wrapper, stream/wait/resume outcomes and retained ownership.
- `packages/cli/src/lib/dev/agui-handler.ts`: observer disconnect requests soft
  Stop after admission, hard shutdown remains hard, one settled terminal fact.
- `packages/cli/src/lib/runtime/execute-route-core.ts` and `b4-context.ts`:
  production internal agent entrypoints and non-agent invocations receive the
  control context. This is essential: CLI does not invoke public BackendAdapter
  uniformly. Never leave the local chain `.invoke(input)` path uncontrolled.
- Existing turn-end/stream helpers may get a narrowly shared stopped-outcome
  classifier. `abortable-iterable.ts` remains a hard-abort mechanism, not soft Stop.
- `examples/software-factory/controller/src/lib/routes/settle.ts` and the
  existing `work-orders/{dispatch,intake,reject-intake}` route modules: explicitly
  adapt app-owned cancel-aware operations to optional RuntimeContext stopSignal.
  Join both operation and triggered factory cancellation cleanup; preserve
  independent failures and natural outcomes before reporting an observed Stop.
  Keep the framework hard signal unchanged. Preserve the existing operator CLI
  cancel, row truth, image cancellation, and serialized command behavior.
- The controller's `src/lib/factory.ts` and `test/factory-cancel.test.ts`:
  transient optional cancellation acknowledgement after accepted branches
  finish local persistence, preserving existing wire and journal shapes. Do not
  infer acknowledgement from row state, messages, or an ambiguous ok flag.
- The controller's `src/cli.ts`, `test/routes.test.ts`, and new
  `test/routes-settle.test.ts`: accurate acknowledgement wording and meaningful
  delayed-cleanup, error-precedence, pre-stop, and late-stop evidence, retaining
  existing CLI cancellation assertions. No global runtime or worker changes.
- Add focused real-runtime tests below and a patch changeset for affected
  publishable packages. Update existing author/runtime docs and regenerate SEO
  lastmod after committing site content. No unrelated CI/release script changes.

## Task 1: Implement and prove the cohesive execution lifecycle

- [ ] Read spec and actual call paths before editing; assert exact branch/base.
- [ ] Write registry RED tests: manual Stop requests separate stop signal but
  leaves hard signal live, shutdown aborts hard signal, duplicate/stale claims,
  pre-stopped execution, and listener release without leaked process listeners.
  Run `pnpm --filter @b4run/cli test run-registry` and preserve meaningful RED.
- [ ] Write real native graph RED tests in new
  `packages/langchain/test/cooperative-stop.test.ts` and
  `packages/langgraph/test/cooperative-stop.test.ts`. Hold active tool, finally,
  and checkpoint writes with barriers, request Stop, assert no early finish or
  signal abort, release, assert no next step and correct outcome. Include
  parallel tools, nested graphs, raw factory tools on unmodified Core, natural
  terminal success, independent errors, and pre-stopped first-node refusal.
- [ ] Implement optional stop context and native control scopes. Example shape:

```ts
// Existing hard signal retains its meaning; stop is a separate request.
type ExecutionContext = {
  readonly signal: AbortSignal
  readonly stopSignal?: AbortSignal
}
// Native graph integration (keep constructor in a LangGraph-dependent package).
const control = new RunControl()
const requestStop = () => control.requestDrain("user_stop")
stopSignal?.addEventListener("abort", requestStop, { once: true })
if (stopSignal?.aborted) requestStop()
try {
  return await graph.invoke(input, { signal, control })
} finally {
  stopSignal?.removeEventListener("abort", requestStop)
}
```

  This is a seam sketch, not permission to swallow GraphDrained or convert every
  stop request to cancellation. Actual drain must retain distinct identity and
  must settle checkpoint writes before classification. Capture cause/error
  truthfully; no class-name authority for permissions or run ownership.
  For stop-capable native calls, use public per-invocation sync durability and
  prove Stop plus rejected checkpoint persistence remains an error. Document
  its checkpoint latency cost. Opaque RuntimeContext gets an owned cooperative
  soft reason; B4ToolContext retains only its existing hard signal.
- [ ] Extend all real CLI execution paths, registry wrapper, and AP/AG-UI
  handlers. Manual Stop must not abort abortableAsyncIterable's source signal.
  Keep observers closable and resources alive while execution drains. AG-UI
  request/response disconnect uses exact soft-stop claim after admission;
  preflight disconnect prevents first dispatch. Hard shutdown/admission loss
  continue to reach the hard controller.
- [ ] Use one actual stopped outcome, not `run.cancelled` request state, for
  terminal event/status/stamp. Natural terminal success may win. Independent
  errors stay errors. Permission parks stay explicitly paused/unanswered.
- [ ] Write real fresh-turn RED tests: drain after model emits a tool call,
  then send fresh user input; source tool must execute zero times. Also cover
  nested partially executed work (do not label all unmatched calls unexecuted),
  real checkpointer failure, and explicit authorized Command resume.
- [ ] Implement nonexecuting retirement of old pending actions under run
  exclusion. Prefer public `updateState(config, null, END)` for known native
  profiles. Preserve state/history and existing dangling-tool model history
  repair; never fabricate successful tool completion. A later fresh turn must
  recheck safety before any model/tool code even if previous retirement failed.
  Unsupported rebinding fails closed. Never clear a live permission park as if
  approved. Do not copy the unrelated durable R8 protocol services.
  Preserve standalone explicit null as native continuation, and test stateless
  compiled graphs without a checkpointer. HTTP null must not bypass permission
  validation. A clean Stop retires pending actions before it is reported.
- [ ] Add real HTTP integration tests in
  `packages/cli/test/cooperative-stop.test.ts` and extend
  `run-cancellation.test.ts`, `run-registry.test.ts`,
  `shared-run-admission.test.ts`, `turn-end-stamp.test.ts`, and transport tests
  where behavior changes. Exercise stream, wait, resume, native SSE/protobuf,
  same-thread 409 through held tool/write cleanup, request-store lifetime,
  exact stale cancellation claims, observer disconnect, and one terminal.
  Update old instantaneous-soft-cancel expectations using barriers, not larger
  deadlines or weaker assertions. Preserve hard-abort and authorization tests.
- [ ] Rebuild before tests reading workspace dist. Run targeted package builds,
  typechecks and meaningful focused suites, then root build when verifying
  runtime consumers. Use no live APIs. Fix new failures with TDD.
- [ ] Commit the coherent implementation and tests on this feature branch.

## Task 2: Document the changed guarantee and verify the release boundary

- [ ] Document superstep versus opaque invocation granularity; awaited owned
  work versus arbitrary detached callbacks; Stop requested versus actual stopped;
  natural completion race; separate hard abort/deadline/shutdown behavior.
- [ ] Document that this PR uses existing APIs and does not claim the unfinished
  coordinated Agent Protocol rollout is active or every backend is drainable.
- [ ] Add patch changeset for actual changed publishable packages. Update the
  relevant existing README/API/runtime docs, with scoped formatting. Commit
  content, run `pnpm --dir apps/web seo:lastmod`, commit generated manifest.
- [ ] Run `pnpm lint`, `pnpm check:build-cache`, `pnpm build`, `pnpm typecheck`,
  source tests, release inventory/controller/docs/pack/tooling/harness gates in
  current `pnpm ci:validate`; do not edit infrastructure to skip a failed gate.
  Exact command evidence and failures go in private logs. Required CI browser
  lane and changesets must run on final PR head; release-bearing extra required
  lanes retain their existing policy.
- [ ] Obtain fresh SPEC review of the complete diff, SAME implementer fixes and
  SAME reviewer rechecks; then fresh independent QUALITY review, same fix loop.
  Recheck affected gates after fixes. No completion assertion with open findings.

## Task 3: Open PR and merge only on green

- [ ] Confirm only intended feature/docs/changeset changes and clean commits.
  Check current main for drift; merge/rebase safely if needed, no force push.
- [ ] Respect at most two active maintainer full-CI submissions, including main.
  Push this pinned branch and create a PR against main. Body leads with Stop's
  before/after behavior, actual granularity and validation; use `--body-file`.
- [ ] Monitor required checks and actual PR head. Investigate and fix failures,
  review comments, conflicts, and stale-head results; never count baseline or
  skipped required jobs as green. Do not cancel unrelated/release runs.
- [ ] With required `validate` and other repository-required checks green on
  final head, merge using normal repository policy without bypass/admin flags.
  User already authorized this conditional merge. Verify merged SHA/PR state
  and main checks. Do not merge a version/release PR or publish packages.
- [ ] Report PR URL, merged commit, tested behavior and material limitations.
  Preserve the original protocol worktree and user's unrelated work.
