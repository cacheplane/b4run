# @dawn-ai/sqlite-storage

## 1.0.0

### Patch Changes

- a30db23: LangChain dependencies move to their current releases: `@langchain/core` 1.2.12, `@langchain/langgraph` 1.4.17, `@langchain/langgraph-checkpoint` 1.1.5, `@langchain/openai` 1.5.13, `@langchain/anthropic` 1.5.11, `@langchain/google-genai` 2.3.2, `@langchain/xai` 1.4.13 and `@langchain/openrouter` 0.4.13, with the peer ranges raised to match. The lockfile is deduplicated so that every workspace package resolves the same single copy of `@langchain/langgraph` and `@langchain/core`.
  - @b4run/workspace@1.0.0

## 0.10.0

### Patch Changes

- Updated dependencies [71bccb3]
  - @b4run/workspace@0.10.0

## 0.9.0

### Minor Changes

- 516c038: Read a managed workspace from a trusted host process. `ManagedWorkspaceProvider` gains an optional `openWorkspaceReader` addressed by the published `ReadyWorkspace` (implemented for Docker as a read-only bind of the managed volume in a separate networkless container that never touches a session), `@b4run/sqlite-storage` gains `openWorkspaceInstallationReader` (a lock-free read-only view of an installation another process owns), and `@b4run/cli/workspace` gains `openManagedWorkspaceReader` / `withManagedWorkspaceReader`, which resolve a thread to its published workspace through that store. `scopedWorkspaceReader` is exported from `@b4run/workspace` as the shared always-close lifetime.

### Patch Changes

- Updated dependencies [516c038]
- Updated dependencies [7410154]
  - @b4run/workspace@0.9.0

## 0.8.36

### Patch Changes

- @b4run/workspace@0.8.36

## 0.8.35

### Patch Changes

- Updated dependencies [89a5958]
  - @b4run/workspace@0.8.35

## 0.8.34

### Patch Changes

- @b4run/workspace@0.8.34

## 0.8.33

### Patch Changes

- @b4run/workspace@0.8.33

## 0.8.32

### Patch Changes

- 0003db2: Add provider-owned managed workspaces with immutable source capture, durable installation ownership and associations, resumable creation/deletion, and incarnation-scoped compute sessions. Node builds retain verified source artifacts; tools receive permission-bound initial bytes and workspace provenance. Docker implements managed preparation and recovery. Add file metadata and binary reads, disposable workspace execution, and isolated test-harness cleanup. Migrate the code-fixer example to ordinary author tools with independently verified, approval-bound candidate export.
- 0003db2: Add internal durable workspace installation ownership with recoverable initialization, exclusive local runtime admission, and guarded source-bundle persistence. Runtime integration follows separately.
- 0003db2: Add Node utilities for capturing and verifying immutable workspace source bundles,
  preserving exact bytes and checking declared file inventories and size limits.
  Add an internal transactional SQLite source-bundle component with strict integrity
  verification. Managed workspace lifecycle and runtime integration remain pending.
- Updated dependencies [0003db2]
- Updated dependencies [0003db2]
  - @b4run/workspace@0.8.32

## 0.8.31

## 0.8.30

## 0.8.29

## 0.8.28

## 0.8.27

## 0.8.26

## 0.8.25

## 0.8.24

## 0.8.23

### Patch Changes

- 7e62bb1: Refresh the GitHub and npm documentation surfaces, add package discovery
  metadata, and introduce reproducible product-loop media. No runtime API changed.

## 0.8.22

### Patch Changes

- bedad77: Documentation only: every public export of this package now has an API reference
  page on dawnai.org, and the package README leads with a concise entrypoint. No
  runtime behavior changed.

## 0.8.21

## 0.8.20

## 0.8.19

## 0.8.18

## 0.8.17

## 0.8.16

### Patch Changes

- 2da55fa: Require Node 24 (the active LTS) everywhere. npm 10 — bundled with Node 22 —
  cannot install Dawn's scaffold dependency graph (its resolver crashes), while
  Node 24's bundled npm ≥ 11 installs it correctly and ships `node:sqlite`
  unflagged. All packages now declare `engines.node >= 24`, `create-dawn-ai-app`
  refuses to scaffold on older Node with an actionable message, `dawn verify`'s
  runtime preflight enforces the same floor, and the `dawn build` node target
  uses a `node:24-slim` base. Scaffolded apps also no longer declare
  `@dawn-ai/core` as a direct dependency — nothing in a generated app imports it
  (it arrives transitively via the CLI and SDK).

## 0.8.15

## 0.8.14

## 0.8.13

## 0.8.12

## 0.8.11

## 0.8.10

## 0.8.9

## 0.8.8

## 0.8.7

## 0.8.6

## 0.8.5

## 0.8.4

## 0.8.3

## 0.8.2

## 0.8.1

### Patch Changes

- 407303f: Friendlier import errors. When a route, tool, or config module fails to load with the opaque ESM error "does not provide an export named X", Dawn now identifies the offending package and explains the likely cause and fix — an older hoisted `@langchain/core` (with the installed-vs-required versions and an `npm ls` pointer) or a CommonJS dependency imported with named bindings under Dawn's ESM resolver. `CliError` now preserves the original error via `cause`. Also aligns `@dawn-ai/sqlite-storage`'s `@langchain/core` peer floor to `^1.1.47` to match the rest of the suite.

## 0.8.0

### Patch Changes

- README refresh for GTM: SEO keyword pass, a Star/Docs/Discussions CTA band on the root and developer-facing package READMEs, doc links repointed to the live dawnai.org site, and READMEs added for previously-blank packages (`workspace`, `permissions`, `sqlite-storage`, `testing`, `evals`).
- Version realignment: all public Dawn packages now share a single version (`0.8.0`) and release together going forward.

## 0.2.0

### Minor Changes

- cfc3e8c: Add Agent Protocol HTTP endpoints backed by a Dawn-native SQLite checkpointer (phase-3 sub-project 7).

  - New `@dawn-ai/sqlite-storage` package: `sqliteCheckpointer` (a `BaseCheckpointSaver` over Node's built-in `node:sqlite`, no native deps) and `createThreadsStore`. Requires Node 22.13+ (where `node:sqlite` is available without the `--experimental-sqlite` flag).
  - `dawn.config.ts` gains `checkpointer` and `threadsStore` fields — both pluggable, with SQLite-backed defaults at `.dawn/checkpoints.sqlite` and `.dawn/threads.sqlite`.
  - The dev server's HTTP layer is reshaped to the Agent Protocol: `POST /threads`, `GET`/`DELETE /threads/{id}`, `POST /threads/{id}/runs/stream`, `POST /threads/{id}/runs/wait`, `GET /threads/{id}/state`, `POST /threads/{id}/resume`. The legacy `POST /runs/stream` is removed.
  - Conversation state and permission interrupts now survive a server restart. `MemorySaver` is removed from `@dawn-ai/langchain`; the checkpointer is supplied by the caller. Permission resume is state-based (reads the parked interrupt from the checkpoint) and resolves the route durably from thread metadata.
