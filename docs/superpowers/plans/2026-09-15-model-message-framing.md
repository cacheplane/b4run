# Model Message Framing Implementation Plan

> Execute inline with superpowers:executing-plans and test-driven-development.

**Goal:** Keep independent model text streams distinct through B4's default AG-UI route.
**Architecture:** Optional token identity plus model completion events pass through the existing runtime. AG-UI tracks open identified messages separately from legacy anonymous text.
**Tech Stack:** TypeScript, LangChain/LangGraph, AG-UI, Vitest, pnpm.

- [x] Add failing regressions in `packages/ag-ui/test/message-framing.test.ts`
  for interleaving, sequential messages, legacy text, terminal cleanup, tool boundaries.
  Run `pnpm --filter @b4run/ag-ui test` and observe framing failures.
- [x] Add failing adapter identity/lifecycle tests in
  `packages/langchain/test/model-message-framing.test.ts`. Cover empty output,
  subagent exclusion, and completion. Run the focused Vitest config.
- [x] Add a real default-route concurrency/approval/resume test in
  `packages/cli/test/agui-model-framing.test.ts` using the existing deterministic
  model fixture and nested FakeStreamingChatModel. Verify independent JSON fails.
- [x] Add optional metadata and completion projection in
  `packages/langchain/src/agent-adapter.ts`; reserve the lifecycle event.
- [x] Carry metadata in `packages/cli/src/lib/runtime/stream-types.ts`,
  `execute-route-core.ts`, and `packages/cli/src/lib/dev/agui-handler.ts`.
  Pin unchanged raw SSE string payload in `packages/cli/test/stream-types.test.ts`.
- [x] Preserve message identity in `packages/cli/src/lib/dev/live-turn-hub.ts`;
  test same-ID coalescing, different IDs, anonymous chunks, and attachment snapshots.
- [x] Extend `packages/ag-ui/src/types.ts` and `outbound.ts` to frame identified
  messages and close them individually or at terminal boundaries.
- [x] Build from root; rerun focused and affected-package tests; fix existing
  exact assertions only where additive metadata or completion changes them.
- [x] Add patch changeset for langchain, cli and ag-ui; document compatibility.
- [ ] Run root validation, obtain independent code review, and open a PR.
  Merge only after required CI, CopilotKit and native Vercel checks pass and
  substantive review findings are addressed.

## Verified progress

Affected package suites: 201 AG-UI, 226 LangChain, and 1816 CLI tests pass;
four CLI tests are skipped by existing infrastructure gates. Root build,
typecheck, and lint pass with existing warnings. Independent spec and quality
reviews approve the change. Full repository validation and remote CI are pending.
