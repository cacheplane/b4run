# Workspace Source Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement and verify an internal, immutable, binary-safe source bundle primitive for the approved managed workspace API.

**Architecture:** Capture is a later caller; this slice accepts explicit in-memory file entries. Canonical encoding, digest verification, and decoding are one bounded component, independent of Docker, SQLite, route execution, and fixture semantics. Do not export an unfinished author-facing API.

**Tech Stack:** TypeScript, Node crypto/Buffer, Vitest, existing pnpm workspace tooling.

---

## Scope and files

Work in the existing isolated worktree and `blove/code-fixer-app-correction` branch.
Do not push or create a PR. All commands run from repo root.

- Create `packages/workspace/src/source-bundle.ts`: internal canonical bundle construction, validation, decoding.
- Create `packages/workspace/test/source-bundle.test.ts`: behavior and malformed-input coverage.
- Modify this plan with completed steps and verification evidence.
- Do not change barrels, runtime config, dependencies, providers, fixture files,
  snapshots, or application behavior. No source-directory traversal in this slice.

Design sources: `docs/superpowers/specs/2026-09-14-workspace-implementation-contracts.md`,
`docs/superpowers/specs/2026-09-14-workspace-authoring-api-proposal.md`, and
`docs/superpowers/specs/2026-09-14-provider-owned-workspace-lifecycle-design.md`.

## Task 1: Canonical construction

- [x] Add tests importing the new internal source module using `.ts`. Cover order
  independence, fixed independently calculated digest vector, exact binary bytes
  (including UTF-8 BOM, NUL, and invalid UTF-8), empty files/source, executable-bit
  identity, and mutation of original input after construction.
- [x] Run `pnpm --filter @b4run/workspace exec vitest run test/source-bundle.test.ts`.
  Confirm failure is because the new implementation is absent.
- [x] Implement this API (internal exports, not package barrel exports):

```ts
interface SourceFileInput {
  readonly path: string
  readonly bytes: Uint8Array
  readonly executable: boolean
}
interface SourceBundle {
  readonly version: 1
  readonly digest: string
  readonly files: readonly {
    readonly path: string
    readonly base64: string
    readonly executable: boolean
  }[]
}
function createSourceBundle(files: readonly SourceFileInput[]): SourceBundle
function verifySourceBundle(value: unknown): SourceBundle
function readSourceFile(bundle: SourceBundle, path: string): Uint8Array
```

  Construction copies bytes to canonical base64 strings, sorts entries by ordinal
  path order, validates portable paths, and rejects path conflicts. Deep-freeze
  returned plain objects/arrays (no mutable typed arrays retained). Verification
  returns a new canonical frozen bundle after strict shape/base64/digest checks.
  readSourceFile validates bundle integrity and path, fails on missing entry, and
  returns a fresh decoded byte array with independently owned, exactly sized
  backing memory (never a view of a shared Buffer pool). Never coerce malformed fields.
- [x] Rerun the focused suite and verify canonical construction cases pass.

## Task 2: Integrity, portability, and limits

- [x] Add failing tests for traversal/absolute/backslash/control paths, invalid
  Unicode, non-NFC, invalid portable characters, reserved device names, trailing
  dots/spaces, case-insensitive collisions, duplicates, and file/ancestor conflicts
  in either input order. Ancestor comparison is case-insensitive too. Include
  positive coverage for .gitignore and .config/settings.json. Reject inconsistent
  casing of implicit directory prefixes (src/a versus SRC/b); allow consistently
  spelled shared directories.
- [x] Add tests for mutated content/digest/mode/path, unknown fields/version,
  noncanonical or invalid base64, duplicate stored entries, and out-of-order
  stored entries. Serialized input must already be canonical; do not silently
  repair malformed persistence records.
- [x] Add bounded-input tests: at most 10,000 entries, 16 MiB per decoded file,
  64 MiB total decoded content, 1,024 ASCII bytes per path, and 255 bytes per
  segment. Validate encoded lengths before base64 decoding, and totals before
  creating duplicate buffers. No unbounded JSON parsing API is introduced.
- [x] Implement these checks with explicit errors. Do not reject a regular path
  named node_modules or .git merely because the prototype did; generic bundles
  describe regular files, while baseline/source-link collision policy belongs to
  the subsequent creation-spec validation layer.
- [x] Run the focused suite; all new cases must pass. Confirm a changed returned
  read buffer cannot mutate bundle identity or a subsequent read.

## Task 3: Review and verification

- [x] Run `pnpm --filter @b4run/workspace test` and
  `pnpm --filter @b4run/workspace typecheck`.
- [x] Run scoped Biome on the two changed TypeScript files using the repository
  package's config. Fix only changed files. Run `git diff --check`.
- [x] Request independent review of the foundation against the three design
  documents, emphasizing malformed persisted input, canonical identity, binary
  preservation, path collisions, and bounded allocations. Address findings with
  regression tests and rerun affected checks.
- [x] Record exact results below and commit the source/tests plus updated plan.
  A full repository validation run belongs to the integrated feature; do not
  report this foundation as working workspace lifecycle or a corrected example.

## Follow-on plans

After this foundation, plan and implement descriptor capture/build/storage, then
Docker/runtime lifecycle, then tool context and application adoption. These are
dependent delivery stages of the approved design, not optional substitutes for
the final code-fixer correction. Managed and Kubernetes provider qualification
remain separately scoped. Keep the user's code walkthrough before any PR.

## Results

Completed on the existing feature branch. The internal module is not exported
from a package entry point and is not yet consumed by runtime or application code.

- Implementer observed initial missing-module RED, construction GREEN (3 tests),
  and subsequent failing portability/integrity cases before implementation.
- Review regression: inconsistent directory-prefix casing failed before the fix.
- Review regression: two-byte reads exposed a shared 65,536-byte backing buffer;
  the new tight-buffer independence test failed before the owned-copy fix.
- Root independently verified the canonical digest vector with Python SHA256.
- Final root verification: workspace package suite **6 files / 135 tests passed**,
  including **96 source-bundle cases**; package typecheck passed.
- Scoped Biome checked both new TypeScript files without errors or fixes;
  whitespace check, build-cache configuration check, and docs check passed.
- Independent spec and code-quality reviews approved after the two fixes.
- Existing fixture compatibility check: cli-flags declares 8 files / 18,706 bytes;
  nullable-inputs declares 14 files / 46,180 bytes. This was a host inventory check,
  not source-capture or provider integration qualification.

No full repository CI, real provider qualification, model calls, public API export,
application migration, push, or PR occurred in this foundation increment. The
previous prototype's full validation remains evidence for that earlier revision,
not for the new integrated feature, which is still pending.
