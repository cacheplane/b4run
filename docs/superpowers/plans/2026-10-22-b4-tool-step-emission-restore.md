# B4 tool-step emission and restore implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Follow the shared contract Rules and this repository's AGENTS.md.

**Goal:** Complete slice 2 of the shared Hashbrown/B4.run tool-step contract: emit and persist v1 steps, preserve failures and provider identity through restore, and filter provider calls from inbound conversation.

**Architecture:** The SDK remains the single owner of the contract. LangChain produces camelCase v1 steps and stores them in ToolMessage.additional_kwargs.b4_step. The AG-UI translator puts the current step on standard tool frames and emits CUSTOM updates without delaying START. Restore uses the same reader, retaining legacy-read compatibility. Existing orchestration suppression and child ownership remain intact.

**Tech stack:** TypeScript, pnpm, Turbo, Vitest, Biome, Changesets.

**Binding design:** Hashbrown `docs/superpowers/specs/2026-10-21-b4-tool-step-contract-design.md`, especially Rules and slice 2. Slice 1's B4 plan is `docs/superpowers/plans/2026-10-21-b4-tool-step-b4run.md` in Hashbrown. Neither detailed plan was copied into B4's main. Source baseline: B4 main edd46f3f9 (0.15.0 released).

## Baseline audit

Already landed: SDK types/readers/schemas/27 fixtures/reference fold; metadata-aware view consumer with legacy-read support. Still legacy: converter CUSTOM payloads use tool_call_id, persisted stamps use ISO times without v/kind, adapter only forwards snake_case, outbound emits no step metadata, restore reads only PersistedStep, inbound does not exclude provider tool results. No AG-UI MESSAGES_SNAPSHOT emitter exists on this baseline; inspect state/turn restoration rather than inventing a new endpoint.

## Task 1: LangChain producers and execution start

Files: `packages/langchain/src/tool-display.ts`, `tool-converter.ts`, `agent-adapter.ts`; permission wrappers/context in `packages/core/src/capabilities/permission-gate.ts` and `types.ts` only if needed for execution timing. Tests: converter-step, tool-display, adapter custom-event and approval cases.

- [x] Write failing tests for versioned camelCase CUSTOM events, epoch-ms persisted steps with stable source ids and failed.error, no persisted toolCallId, denied outcome, and real execution timing across approval pause/resume.
- [x] Run focused tests and confirm the intended failures.
- [x] Replace emitter shapes with B4ToolStep. Every identifiable server call emits its actual execution-start update; permission waiting is not falsely presented as execution. Preserve gate display and interrupt behavior. Retain legacy parsing at external boundaries.
- [x] Run affected package tests/typecheck/lint; use conditional spreads for exact optional types.

## Task 2: AG-UI frame metadata

Files: `packages/ag-ui/src/types.ts`, `outbound.ts`; tests under `packages/ag-ui/test/`.

- [x] Test-first: streamed START remains immediate; START/END carry v1 metadata when an execution step already exists (never fabricate execution timing at model announcement), RESULT carries the persisted final step (including failed error); CUSTOM and metadata retain queries/sources/timing/provider fields and child ownership.
- [x] Normalize versioned and legacy step chunks with the SDK reader. Keep step state by owner/call, merge with SDK rules, and omit toolCallId in metadata. Never buffer a normal streamed call awaiting completion.
- [x] Read final ToolMessage steps from direct and Command results, preserving matching call identity and readable error content. Preserve existing orchestration ledger suppression.
- [x] Run AG-UI tests, typecheck and lint.

## Task 3: Restore and inbound replay safety

Files: `packages/ag-ui/src/view/turns-from-state.ts`, `inbound.ts`; CLI thread-turns tests as needed. Add a shared internal persisted-step reader only if it avoids inconsistent projections.

- [x] Test-first: v1 completed/failed/denied/cancelled steps restore with sources/timing/decision; legacy stamps still restore; failures are visible in snapshot-compatible ToolMessage metadata/error and /turns; abnormal unfinished calls still settle.
- [x] Use readToolStep for persisted stamps, normalize both timestamp forms without losing existing clock clamping. Raw `/state` remains the LangChain checkpoint with `additional_kwargs.b4_step` and `status: error`; `eventsFromState` (the `/events` projection consumed by `/turns`) projects persisted b4_step onto tool-result metadata, and emit appropriate top-level errors when synthesizing failure frames. Do not introduce a new snapshot endpoint.
- [x] Test-first: drop inbound tool results marked provider and results whose assistant call is marked provider, preserving neighboring user/client tool content and the untouched raw input. Assistant tool calls already are not replayed by this structural adapter; retain that boundary, including provider calls.
- [x] Run restore/inbound and CLI turns endpoint/equivalence tests.

## Task 4: Cross-path validation, docs and release metadata

- [x] Add/extend a real graph integration test covering live and restored success, failure, denial, approval/resume and display-less tools. Compare contract fields through the shared view consumer; no live API or recording required.
- [x] Update AG-UI docs, SDK docs/upgrading where behavior changes, add patch changeset for affected published packages. Retain deprecated reader/type exports.
- [x] Run focused checks first, then `pnpm ci:validate`; report infrastructure failures and warnings accurately. Do not add dependencies or print keys.
- [x] Request independent spec/correctness review and address findings. Commit code/docs, then regenerate site lastmod using `pnpm --dir apps/web seo:lastmod` after the content commit.
- [x] Prepare a PR if authorized; merging and release require separate user approval. Preserve all unrelated worktrees and changes.

## Implementation notes

- Approval/constraint wrappers mark internal gated execution and await an idempotent converter callback after all nested gates allow the body. Subagent dispatch starts after its guarded resolver accepts the call. Denied calls have no invented start time.
- Approval display is applied from the interrupt to the awaiting view; restore emits no fake execution-start CUSTOM for it.
- Existing raw checkpoint storage remains LangChain-shaped. The existing `/events` replay and `/turns` projections carry the final v1 metadata and errors; no snapshot endpoint was added.
- Independent review added regressions for legacy source identity, ToolMessage.error precedence, absent settledAt fallback, cancelled-call restarts, and late-running updates after frame-only results.

## Validation record

- Full workspace lint (31 tasks), build (29 tasks), and typecheck (59 tasks) pass. All 1,932 source tests in the changed runtime packages pass.
- The broad source run finished with 12,421 passed, 345 skipped, and seven failures: three CLI fixture expectations corrected and verified separately, plus four unchanged timeout cases. Vercel/watcher cases pass in isolation; the sandbox cases pass diagnostically with a longer timeout. No timeout changes are included.
- Release integrity/inventory/controller, chart-version, docs, package checks, TypeScript tooling pack, harness self-tests, runtime parity and smoke harness pass. The framework harness exposed one stale Navlog v1 expectation; the exact assertions were updated, including matching CUSTOM/RESULT metadata and producer timing. The full focused Navlog npm/build/server/browser activation lifecycle then passed.
- PR: https://github.com/cacheplane/b4run/pull/1086. Merging and release remain subject to user approval.
