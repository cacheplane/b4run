# Code-fixer — server

The B4 code-fixer blueprint's fixture qualification package. This checkpoint
provides the two real failure cases; it does not yet run a coding agent.

## Qualify the targets

Prerequisites: Node 24 or newer, pnpm 10, Git, and npm registry access for locked
fixture installation. No provider key is required. Run from the monorepo root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @b4-example/code-fixer-server test
pnpm --filter @b4-example/code-fixer-server typecheck
pnpm --filter @b4-example/code-fixer-server fixtures:qualify -- --task cli-flags
pnpm --filter @b4-example/code-fixer-server fixtures:qualify -- --task nullable-inputs
```

Omit `--task` to qualify both. Each command creates a temporary copy, installs
locked dependencies with install scripts disabled, verifies the intended test
failure, applies the checked-in historical repair, and runs the visible and
additional checks. It prints a JSON receipt and removes the temporary copy.
An unsuccessful qualification exits nonzero.

This command executes only maintainer-reviewed fixture/reference code locally.
It must never receive agent-submitted source or patches. Independent sandboxed
verification of agent changes is a later implementation stage.

| Fixture | Real boundary | Expected baseline failure |
|---|---|---|
| `cli-flags` | Commander registration → argument handler | `unknown option '--dry-run'` |
| `nullable-inputs` | TypeScript compiler → JSON schema → Zod validator | `nullable-input rejected` |

The manifest's `sourceCommit` identifies the exact faulty source baseline.
`extractionNotes` identifies reductions and the reference repair commit. The
nullable fix originated in PR #573 and was refreshed under issue #605; its
source snapshot comes from the parent of that refreshed repair.

`project/` is the future agent workspace. `checks/` and `reference.patch` are
maintainer/evaluator material and must not be seeded into it. Directly running
`npm test` inside a faulty target is expected to fail. Root B4 test discovery
runs the qualification contract tests rather than these deliberately red tests.

No claim of model task success, Docker isolation, or developer productivity
improvement follows from fixture qualification. These are separately verified
in the remaining blueprint plan.
