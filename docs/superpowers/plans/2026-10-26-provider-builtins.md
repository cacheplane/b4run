# B4 provider built-ins Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development task by task, with test-first implementation and independent review.

**Goal:** Surface provider built-ins and answer annotations live and after restore without corrupting native model replay.

**Architecture:** A pure SDK normalizer is reused by LangChain live/persistence paths and AG-UI history synthesis. Persist display projection separately from unchanged native v0 messages; keep streamEvents v2.

**Tech Stack:** Existing TypeScript, pnpm, Turbo, Vitest, Biome, LangChain and Changesets. No dependency change without approval.

**Spec:** ../specs/2026-10-26-provider-builtins-design.md and the binding shared contract Rules.

## Task 1: Pure provider normalizer

Files: new packages/sdk/src/provider-tool-steps.ts (split provider readers into focused sibling files if needed), packages/sdk/src/index.ts, packages/sdk/test/provider-tool-steps.test.ts.

- [x] Write failing tests for native OpenAI web search/progress/failure/code/image data, Anthropic server search/input/result/error, v1 server blocks, Google call-less grounding/code/attribution, source/citation correlation, stored map fallback and immutability.
- [x] Run focused SDK tests and verify expected failure before implementation.
- [x] Implement normalizeProviderMessage and documented structural result types without runtime imports; raw status/details override lossy v1 translations. Never invent a grounding call or settle at EOF.
- [x] Run focused tests, SDK full tests/build/lint/typecheck. SDK 285 tests pass; pre-existing middleware.ts lint warning remains.
- [x] Independent spec and quality review; fixed sparse-settlement sources, citation occurrence/container identity, disabled Anthropic v1 paths and settled labels. SDK 289 tests and all gates pass through 039ca0ca9.

## Task 2: Live projection and canonical persistence

Files: packages/langchain/src/agent-adapter.ts, agent-middleware.ts, tool-loop.ts, new provider stream-state helper; focused provider-builtins stream/checkpoint tests.

- [x] Write failing immediate-START, streamed args, native failure, reconciliation/dedupe, owner isolation and real createAgent checkpoint tests.
- [x] Implement invocation-scoped accumulation, native provider frames, answer annotations and nonmutating canonical AIMessage stamping before checkpoint writes.
- [x] Keep provider calls outside ordinary tool_calls and execution. Pin v0 output where B4 constructs the provider model. Document custom graph persistence boundary.
- [x] Run LangChain tests/build/lint/typecheck; independent spec/quality review approved, 604 tests pass. Committed 3d1601a89.

## Task 3: AG-UI live/restore/view annotations

Files: packages/ag-ui/src/{types,outbound}.ts, src/view/{turns,turns-from-state}.ts and focused outbound/restore/inbound conformance tests.

- [x] Write failing tests for provider step metadata on START/END/RESULT, readable failed-result error, message-scoped b4.answer, native AIMessage restore and source/attribution parity.
- [x] Implement explicit result-step and annotation carriers, provider-map restore using the shared normalizer, and message-id keyed view annotations. Preserve existing inbound filtering.
- [x] Run AG-UI standard/Angular tests/build/lint/typecheck and SDK shared-fixture conformance; independent spec/quality review approved, 742 standard and 185 Angular tests pass. Committed 3d1601a89.

## Task 4: Author-facing enabling and Google transport decision

Files: SDK agent options; LangChain model construction/import maps; CLI provider dependency/build paths as needed; relevant tests and docs.

- [x] User approved agent() builtInTools and Google dependency replacement. Compatible core patch update is required by the replacement's peer range.
- [x] Write enabling tests first: configuration/passthrough/collision/source-plumbing; reject file search, unsupported providers, and Anthropic fetch/code.
- [x] For approved Google replacement, verify installed replacement's exact streaming/native-history behavior and test metadata-only grounding preservation, attribution, and model replay without live calls.
- [x] Replacement approved: retain metadata-only candidates and native invocation evidence through the public handler bridge; verify native replay without live calls.
- [x] Run affected package gates, review and commit. SDK 321 and LangChain 632 tests passed before final aggregate review; Google bridge 9 and SDK Google 8 tests independently approved. Committed 912717c20.

## Task 5: End-to-end conformance, docs and delivery

Files: CLI thread/turn equivalence tests, apps/web/content/docs/{agents,ag-ui,upgrading,api/sdk}.mdx as applicable, package README, patch changeset, SEO lastmod manifest.

- [x] Exercise real runtime -> AG-UI -> SDK fold/view -> persisted checkpoint -> restore, plus native second-turn replay and provider inbound exclusion.
- [x] Document enabling defaults/limitations and Google rendering obligations; keep file search deferred, Bedrock unsupported, Anthropic fetch/code disabled. Add a patch changeset.
- [ ] Run pnpm ci:validate and affected independent release-bearing lanes when available; distinguish infrastructure restrictions from code failures. No live recordings or keys.
- [x] Commit site content, regenerate apps/web SEO lastmod, commit generated manifest and verify.
- [ ] Final independent review; fix issues; open a focused PR and enable requested repository autofix mechanism. Do not merge without current user authorization for this new PR.

## Baseline evidence

At main 1a4e4551b, pnpm build passed all 29 tasks (cached; two existing web
dynamic-filesystem tracing warnings). SDK 264, LangChain 580, AG-UI standard 703
and Angular 185 tests passed. AG-UI HTTP conformance requires loopback access;
the restricted sandbox's EPERM was resolved by rerunning with that access.
Locked install changed no dependency manifests; pnpm reported its existing
ignored native build-script policy. SDK implementation commits: 397e91524 and
1abfd462d, including test-first fixes from independent review.

## Final review evidence

Independent component and aggregate reviews covered normalizer, enabling,
Google transport, streaming persistence and AG-UI restore. Aggregate review
found one live/restore discrepancy: a later authoritative native failure updated
the step but left a prior lossy success result visible. A failing regression
preceded the result-signature correction. The corrected path emits one call
lifecycle, updates only materially changed results, and deduplicates unchanged
final output. All 22 provider stream tests and the reviewer's complete AG-UI
reproduction pass. A homepage source-text check was made whitespace-insensitive
after the persistence wrapper changed indentation; all 17 checklist tests pass.

The first unrestricted full test run accumulated wall-clock timeouts in
untouched CLI, workspace and homepage cases and stalled on an idle worker. It
was stopped; the complete validation is rerunning with VITEST_MAX_WORKERS=4.
The repository's configured formatter was restored after a scoped invocation
without its configuration introduced formatting noise; no broad reformat is
retained.
