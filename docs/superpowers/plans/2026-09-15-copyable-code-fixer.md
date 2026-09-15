# Copyable Code-fixer Implementation Plan

> Use superpowers:subagent-driven-development for independent tasks and review.

**Goal:** Make the example demonstrate application code, with maintainer machinery
outside the app and reusable workspace inspection in B4.

**Architecture:** One default sample in the copyable app; secondary fixtures and
batch recordings under test/code-fixer. A shared library inspection primitive
serves both author tools and verifier code. Tests retain exact-candidate controls.

**Tech Stack:** Existing TypeScript, B4 workspace/testing/evals, Vitest, Docker.

## Task 1 — Shared workspace inspection

- [ ] Add tests first for bounded inventory, invalid paths, cancellation, binary/
  invalid UTF-8, executable files, symlinks and expected dependency links.
- [ ] Add inspectWorkspace to packages/workspace/src, accepting an author
  WorkspaceFs or SandboxHandle, with explicit options and required metadata.
  Return typed text-file inventory plus validated link identity. Provide a single
  traversal implementation with adapters; no shell program assembled by app code.
- [ ] Export/typecheck/document the API and add a patch changeset.

## Task 2 — Copyable app and maintainer boundary

- [ ] Move batch workers, publication evidence, consumer qualification, historical
  fixture qualification and associated tests to test/code-fixer. Preserve the
  second historical fixture there; default app has one sample. CI must retain
  both fixture replays and cleanup/failure coverage.
- [ ] Replace src/fixtures with clear project configuration. Keep route-local
  evals and focused tests. Consolidate scoring instead of retaining two paths.
- [ ] Remove unused interactive handling and impossible token-budget check.
  Use b4 executable commands and retain one Docker setup step.
- [ ] Update imports, TypeScript/Vitest/package/CI wiring and maintainer runbook.

## Task 3 — Review mechanics and first-run experience

- [ ] Use library inspection from Task 1 in candidate preparation and verifier;
  remove duplicate walkers and keep all review boundaries.
- [ ] Replace full-file diffs with contextual diffs using a maintained existing
  dependency or a suitable small implementation with meaningful patch tests.
- [ ] Document exact invocation/approval steps, normal tests, maintainer-only
  commands, and the still-qualified public distribution pin.

## Task 4 — Verification and adversarial readability review

- [ ] Run focused tests/build/typecheck and Docker integration/replays, including
  the retained second fixture. Resolve failures without weakening controls.
- [ ] Independently review correctness and ask: Is this example code we want
  users to use? Record what authors still need to write and any remaining gaps.
- [ ] Run required local checks, create PR, wait for green required hosted CI,
  merge exact reviewed head, and verify merged status.

## Isolated-copy acceptance

The copied application must contain no imports or runtime reads into `test/code-fixer`, including eval inputs and scorers. Verify setup, build, tests, and the ordinary eval command against locally packed packages before advancing any published installation pin.
