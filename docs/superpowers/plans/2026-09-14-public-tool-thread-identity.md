# Public tool thread identity implementation plan

> Execute inline with superpowers:executing-plans. Independent plan and final
> review required. Preserve this worktree. Walk through code before creating a PR.

**Goal:** Give authored tools a documented typed view of existing runtime thread identity.
**Architecture:** An additive optional SDK field, with type contracts and converter
regressions. No new identity source, sandbox manager, or permission behavior.
**Tech stack:** TypeScript, Vitest, SDK contract compilation, Markdown, changesets.
**Spec:** ../specs/2026-09-14-code-fixer-library-adoption-design.md, section 1.

## Tasks

- [x] Extend `packages/sdk/test/tool-context.contract.ts` without removing bare-tool
  coverage. Read `ctx.threadId` as `string | undefined`; allow context construction
  without it; use `@ts-expect-error` for assignment to the readonly property.
  Run `pnpm --filter @b4run/sdk typecheck`; confirm the missing-property error.
- [x] Add `readonly threadId?: string` and precise JSDoc to
  `packages/sdk/src/workspace-fs.ts`. Rerun SDK typecheck.
- [x] Extend `packages/langchain/test/tool-converter.test.ts` around existing
  configurable-forwarding coverage: without runtime identity the context has no
  identity; an input field named threadId cannot override configured identity.
  Run converter tests and SDK tests. Existing forwarding behavior should pass;
  do not manufacture a runtime failure when only the public type was missing.
- [x] Document optional thread identity in `apps/web/content/docs/tools.mdx`;
  explicitly distinguish conversation identity from authorization. Add a patch
  changeset for `@b4run/sdk`. No CLI/runtime changes unless a demonstrated failure
  requires revisiting scope.
- [x] Run SDK typecheck/tests, focused converter tests, scoped formatting checks,
  docs and changeset checks, and whitespace checks. Review diff independently.
  Record actual checks and remaining full validation before a future PR.
- [ ] Show the user the exact public contract and how the corrected example will
  consume it. Keep broader lifecycle/eval/usage work separately tracked in the spec.

## Implementation checkpoint

Implemented locally; independent review approved. Initial SDK typecheck failed
with missing-threadId errors before implementation. Build passed (26 tasks);
SDK and LangChain typechecks passed; SDK tests 110/110; converter tests 29/29;
CLI workspace/tool-discovery tests 8/8. Scoped Biome, docs completeness, SEO
lastmod and whitespace checks passed. A patch changeset is included; the committed
diff changeset check follows this checkpoint. Full repository CI remains required
before a PR/merge. No runtime implementation or code-fixer behavior changed.
