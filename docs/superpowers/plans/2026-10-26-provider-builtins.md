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

- [ ] Write failing immediate-START, streamed args, native failure, reconciliation/dedupe, owner isolation and real createAgent checkpoint tests.
- [ ] Implement invocation-scoped accumulation, native provider frames, answer annotations and nonmutating canonical AIMessage stamping before checkpoint writes.
- [ ] Keep provider calls outside ordinary tool_calls and execution. Pin v0 output where B4 constructs the provider model. Document custom graph persistence boundary.
- [ ] Run LangChain tests/build/lint/typecheck; independent review and commit.

## Task 3: AG-UI live/restore/view annotations

Files: packages/ag-ui/src/{types,outbound}.ts, src/view/{turns,turns-from-state}.ts and focused outbound/restore/inbound conformance tests.

- [ ] Write failing tests for provider step metadata on START/END/RESULT, readable failed-result error, message-scoped b4.answer, native AIMessage restore and source/attribution parity.
- [ ] Implement explicit result-step and annotation carriers, provider-map restore using the shared normalizer, and message-id keyed view annotations. Preserve existing inbound filtering.
- [ ] Run AG-UI standard/Angular tests/build/lint/typecheck and SDK shared-fixture conformance; independent review and commit.

## Task 4: Author-facing enabling and Google transport decision

Files: SDK agent options; LangChain model construction/import maps; CLI provider dependency/build paths as needed; relevant tests and docs.

- [ ] Resolve pending user preference for agent() builtInTools and explicit approval for Google dependency replacement.
- [ ] If enabling is included, write failing configuration/passthrough/collision/source-plumbing tests before implementation; reject file search, unsupported providers, and Anthropic fetch/code.
- [ ] For approved Google replacement, verify installed replacement's exact streaming/native-history behavior and test metadata-only grounding preservation, attribution, and model replay without live calls.
- [ ] If replacement is declined, gate Google enabling explicitly rather than buffering or losing required attribution. Retain normalization of safely supplied custom-route data.
- [ ] Run affected package gates, review and commit.

## Task 5: End-to-end conformance, docs and delivery

Files: CLI thread/turn equivalence tests, apps/web/content/docs/{agents,ag-ui,upgrading,api/sdk}.mdx as applicable, package README, patch changeset, SEO lastmod manifest.

- [ ] Exercise real runtime -> AG-UI -> SDK fold/view -> persisted checkpoint -> restore, plus native second-turn replay and provider inbound exclusion.
- [ ] Document enabling defaults/limitations and Google rendering obligations; keep file search deferred, Bedrock unsupported, Anthropic fetch/code disabled. Add a patch changeset.
- [ ] Run pnpm ci:validate and affected independent release-bearing lanes when available; distinguish infrastructure restrictions from code failures. No live recordings or keys.
- [ ] Commit site content, regenerate apps/web SEO lastmod, commit generated manifest and verify.
- [ ] Final independent review; fix issues; open a focused PR and enable requested repository autofix mechanism. Do not merge without current user authorization for this new PR.

## Baseline evidence

At main 1a4e4551b, pnpm build passed all 29 tasks (cached; two existing web
dynamic-filesystem tracing warnings). SDK 264, LangChain 580, AG-UI standard 703
and Angular 185 tests passed. AG-UI HTTP conformance requires loopback access;
the restricted sandbox's EPERM was resolved by rerunning with that access.
Locked install changed no dependency manifests; pnpm reported its existing
ignored native build-script policy. SDK implementation commits: 397e91524 and
1abfd462d, including test-first fixes from independent review.
