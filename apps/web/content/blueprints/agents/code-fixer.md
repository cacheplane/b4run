---
description: Install a code-fixing agent with isolated Docker workspaces, independent verification, and approval-gated local export.
website: https://github.com/cacheplane/b4run/tree/0003db2802b718ed167c8266b09a2d00ae01a522/examples/code-fixer
version: 1
tags: [agents, code-fixer, docker, evaluation, approval]
source: official
---

# Code-fixer agent

You are a coding agent installing the qualified code-fixer example as ordinary
B4.run application files. `b4 add code-fixer` prints this guide; it does not
install dependencies or run the application. Apply it within the user's requested
installation scope.

Use source commit **`0003db2802b718ed167c8266b09a2d00ae01a522`** from
`cacheplane/b4run` and published B4 package release **`0.8.32`** throughout.
Do not substitute a branch, `latest`, workspace links, or another package release.
The [pinned example](https://github.com/cacheplane/b4run/tree/0003db2802b718ed167c8266b09a2d00ae01a522/examples/code-fixer)
is the implementation authority. Copy its files; do not handwrite a second agent.
The deterministic replay checks historical repairs; it does not measure live-model
repair quality.

## Inspect the destination

Identify the package manager and lockfile, workspace layout, existing B4 app and
routes, environment conventions, TypeScript settings, client/Workbench integration,
and package versions. Read the destination's contributor instructions. Look for
`// b4-blueprint: code-fixer@1` in `src/app/fix/index.ts` and previous installation
notes. Compare files against recorded hashes before changing a previous install;
preserve user edits and do not silently reinstall.

Prefer a separate sibling app for an existing project. Sandbox providers,
permissions, and durable storage are app-global. Reuse an existing app only when
its Docker workspace configuration, storage, permissions, compiler settings, and
`/fix` route are demonstrably compatible. Explain conflicts and use a sibling app
by default. A deliberate shared-app migration requires separate review. Do not
overwrite an existing sandbox provider, broaden permissions for unrelated routes,
or silently convert a local-filesystem app into a sandboxed app. Preserve unrelated
routes, Workbench settings, environment files, dependencies, package-manager
overrides/resolutions, and runtime configuration overrides.

## Create a new app when needed

Require **Node 24 or newer**, Git, and a running Docker daemon. Confirm with
`node --version`, `git --version`, and `docker info`. An API key is needed only for
a user-authorized live-model run, not replay or deterministic acceptance tests.

For a new app, select an unused target outside an existing package workspace unless
that workspace's dependency policy can preserve the exact release. Replace
`<new-target>` with that path and use the supported public scaffold:

```sh
npm exec --yes --package=create-b4-app@0.8.32 -- create-b4-app <new-target> --template basic --dist-tag 0.8.32
```

Here `--dist-tag 0.8.32` writes literal `0.8.32` B4 dependency specifiers. Do not
use internal scaffold mode. Follow the detected package manager for the app's
subsequent commands and retain its lockfile; npm launches the scaffold regardless
of which package manager you choose for the app.

Record the freshly generated file inventory before applying the example. In an
app created by this command, remove only the identified scaffold demonstration
route `src/app/(public)/hello/` and its `test/agent.test.ts`. Generated `.b4` route
declarations may be regenerated after removal. Never remove those paths from a
pre-existing app without establishing that they are untouched scaffold files and
that their removal is within scope. Preserve the scaffold's `AGENTS.md`, metadata,
ignore rules, and compatible extra dependencies. Its initial `build` script runs
TypeScript; replace that fresh scaffold script with `b4 build` as described below.

## Acquire the pinned source

Fetch into a new temporary directory, separate from the destination. These
commands acquire source only; they do not execute any fetched script:

```sh
B4_CODE_FIXER_REV=0003db2802b718ed167c8266b09a2d00ae01a522
B4_CODE_FIXER_SOURCE=$(mktemp -d)
git -C "$B4_CODE_FIXER_SOURCE" init --quiet
git -C "$B4_CODE_FIXER_SOURCE" remote add origin https://github.com/cacheplane/b4run.git
git -C "$B4_CODE_FIXER_SOURCE" fetch --depth=1 origin "$B4_CODE_FIXER_REV"
test "$(git -C "$B4_CODE_FIXER_SOURCE" rev-parse FETCH_HEAD)" = "$B4_CODE_FIXER_REV"
git -C "$B4_CODE_FIXER_SOURCE" ls-tree -r --name-only "$B4_CODE_FIXER_REV" -- examples/code-fixer/server packages/config-typescript
B4_CODE_FIXER_EXTRACT=$(mktemp -d)
git -C "$B4_CODE_FIXER_SOURCE" archive "$B4_CODE_FIXER_REV" \
  examples/code-fixer/server \
  packages/config-typescript/base.json \
  packages/config-typescript/library.json \
  packages/config-typescript/node.json | tar -xf - -C "$B4_CODE_FIXER_EXTRACT"
```

Verify the command results and inventory before copying. The table is the complete
installation allowlist, relative to the pinned repository; everything else in
the extracted server tree is reference material only. Copy directory entries
recursively, including hidden files such as `.gitkeep`.

| Source | Destination/use |
|---|---|
| `examples/code-fixer/server/src/app/fix/**` | `src/app/fix/`: route, tools, skill, plan, and eval |
| `examples/code-fixer/server/src/fixtures/**` | `src/fixtures/`: trusted catalog and workspace descriptor |
| `examples/code-fixer/server/src/review/**` | `src/review/`: candidate validation, verification, export |
| `examples/code-fixer/server/src/evaluation/**` | `src/evaluation/`: replay and batch evaluation |
| `examples/code-fixer/server/fixtures/**` | `fixtures/`: exact historical projects, manifests, tasks, reference repairs, host-only checks |
| `examples/code-fixer/server/workspace/.gitkeep` | `workspace/.gitkeep`: workspace capability discovery |
| `examples/code-fixer/server/scripts/prepare.ts` | `scripts/prepare.ts` |
| `examples/code-fixer/server/scripts/qualify.ts` | `scripts/qualify.ts` |
| `examples/code-fixer/server/scripts/eval.ts` | `scripts/eval.ts` |
| `examples/code-fixer/server/scripts/attempt-worker.ts` | `scripts/attempt-worker.ts` |
| `examples/code-fixer/server/scripts/export.ts` | `scripts/export.ts` |
| `examples/code-fixer/server/test/**` | `test/`: unit and Docker acceptance checks |
| `examples/code-fixer/server/vitest.config.ts` | Unit-test configuration |
| `examples/code-fixer/server/vitest.sandbox.config.ts` | Docker-test configuration |
| `examples/code-fixer/server/Dockerfile` | Prepared dependency image recipe |
| `examples/code-fixer/server/.dockerignore` | Exact prepared-image context allowlist |
| `examples/code-fixer/server/b4.config.ts` | Reviewed app-global configuration; merge only into a compatible app |
| `examples/code-fixer/server/package.json` | Dependency and script reference; merge as below |
| `examples/code-fixer/server/tsconfig.json` | Compiler configuration with local extends transformation below |
| `examples/code-fixer/server/.env.example` | Environment reference; merge without touching populated secrets |
| `packages/config-typescript/base.json` | `config/base.json` |
| `packages/config-typescript/library.json` | `config/library.json` |
| `packages/config-typescript/node.json` | `config/node.json` |

Exclude `scripts/consumer.ts` and its `verify:consumer` command: they are
repository qualification helpers. Do not copy `node_modules`, `.b4`, generated
artifacts, credentials, or an existing `.env`. Keep fixture project inventories
exact, including their own `package-lock.json` files. Do not install dependencies
inside fixture source directories: image preparation installs their dependencies.
Reference repairs and independent checks must remain host-only, outside captured
agent source and the prepared image. Retain the exact `.dockerignore` allowlist;
if an existing app's Docker context conflicts, use a sibling app.

## Apply the standalone transformations

1. Merge `package.json`, preserving the app's name, metadata, compatible extra
   dependencies, and overrides. Pin runtime packages `@b4run/cli`, `@b4run/sdk`,
   `@b4run/sandbox`, and `@b4run/workspace` to literal `0.8.32`. Pin development
   packages `@b4run/testing` and `@b4run/evals` to literal `0.8.32` too. Keep any
   scaffold B4 packages at that same exact release. Use the pinned source's exact
   non-B4 dependency versions where dependencies are added. Resolve incompatible
   existing requirements through a sibling app, never by silently deleting overrides
   or mixing unqualified B4 versions. Do not copy `workspace:*` specifiers.
2. Copy the three compiler files into `config/`, retaining their relative extends
   chain. Change the copied `tsconfig.json` to `"extends": "./config/node.json"`.
   Preserve its include list, `rootDir`, and `allowImportingTsExtensions`, plus
   inherited `exactOptionalPropertyTypes`, NodeNext imports, and JSON-module support.
   Do not copy the example's `@b4run/config-typescript: workspace:*` dependency.
   An already present compatible scaffold package may remain, but the app's
   configuration must use the local files. Existing compiler conflicts require a
   sibling app or separately reviewed integration.
3. Register `dev: b4 dev`, `check: b4 check`, `build: b4 build`,
   `start: node .b4/build/server.mjs`, and `eval: b4 eval`. Copy the source commands
   for `typecheck`, `test`, `fixtures:qualify`, `sandbox:prepare`, `test:sandbox`,
   `eval:live`, `eval:replay`, and `evidence:export`. Omit the repository-only
   `lint` and `verify:consumer` commands; retain the destination's existing lint
   command if present. Fresh scaffold demo commands may be replaced deliberately;
   for pre-existing app script conflicts use documented namespaced commands and
   adjust every verification command accordingly. Keep live evaluation separate
   from normal startup.
4. Review `b4.config.ts` before applying it. Preserve network denial, resource
   limits, read-only prepared dependencies, durable storage, and approval-gated
   export. Select a stable installation-specific Docker scope, or retain an
   existing reviewed compatible scope. The CLI fixture is the default;
   trusted host setting `B4_CODE_FIXER_TASK=nullable-inputs` selects the alternative
   for new workspaces. Preserve explicit compatible model/environment conventions;
   `gpt-5-mini` is the default otherwise. Never put host API keys in the sandbox
   environment. Merge ignore rules for `.b4`, `artifacts`, `.env`, and `.env.*`,
   retaining an exception for `.env.example` and existing user rules.
5. Add this first line to the copied primary route `src/app/fix/index.ts`:

   ```ts
   // b4-blueprint: code-fixer@1
   ```

   Make no other agent, tool, fixture, or test implementation edits. Record hashes
   after this documented marker addition and the configuration transformations.
   Record user-specific configuration choices separately from the pinned source.
6. Install with the detected package manager, review its lockfile, and retain it
   with the installation. The scaffold lockfile must be refreshed after merging
   dependencies; do not use a frozen install against the old scaffold graph.
   Do not copy the monorepo lockfile or overwrite the fixtures' lockfiles. Record
   exact resolved versions and package integrity, then verify a subsequent frozen
   install (`npm ci`, `pnpm install --frozen-lockfile`, or the detected equivalent).

## Verify the installation

Run from the standalone app directory, using the detected package manager and any
recorded namespaced script equivalents. For npm:

```sh
npm install
npm ci
npm run sandbox:prepare
npm run fixtures:qualify
npm run check
npm run build
npm run typecheck
npm test
npm run eval:replay
npm run test:sandbox
```

Both replay fixtures must pass all six criteria and stop at `approval-pending`.
Replay uses historical patches and makes no paid model calls. Docker acceptance
must demonstrate actual approve/resume and denial, independent verification,
and killed-verifier cleanup. These are standalone app checks; the contributor
monorepo CI sequence is not an installation prerequisite.

### Exercise the built HTTP runtime without a model key

`eval:replay` does not exercise the built HTTP server. Use a temporary host-only
verification helper with the public `@b4run/testing` API for this separate smoke
check. Keep the helper outside `src/app` and out of normal runtime imports.

1. Import `createAimock` from `@b4run/testing` in the helper and start these two
   deterministic fixtures, with no proxy configured:

   ```ts
   import { createAimock } from "@b4run/testing"

   const mock = await createAimock({
     fixtures: [
       {
         match: {
           userMessage: "read the qualification task",
           turnIndex: 0,
           hasToolResult: false,
         },
         response: {
           toolCalls: [{
             id: "qualification_read",
             name: "readFile",
             arguments: { path: "TASK.md" },
           }],
         },
       },
       {
         match: {
           userMessage: "read the qualification task",
           turnIndex: 1,
           hasToolResult: true,
         },
         response: {
           content: "Qualification task read through the managed workspace.",
         },
       },
     ],
   })
   ```

2. While the mock remains running, spawn `node .b4/build/server.mjs` from the app
   directory with `HOST=127.0.0.1`, an unused `PORT`,
   `OPENAI_BASE_URL=mock.baseUrl`, and a dummy `OPENAI_API_KEY`. Pass `mock.baseUrl`
   exactly as returned; it already includes `/v1`. Override any inherited real
   provider credentials/base URL for this child. Retain server logs and use bounded
   startup/request timeouts.
3. Wait for a successful `GET /healthz`, then inspect `GET /info` for the `/fix`
   route on that loopback server. Create a thread with `POST /threads`, JSON body
   `{}`, and retain its returned thread ID.
4. Send `POST /threads/<thread-id>/runs/wait` with `Content-Type: application/json`
   and this body:

   ```json
   {
     "route": "/fix#agent",
     "input": {
       "messages": [{ "role": "user", "content": "read the qualification task" }]
     }
   }
   ```

   Require a successful run containing the `readFile` tool result with the fixture
   task text and the final response
   `Qualification task read through the managed workspace.`. A successful build,
   health response, or route listing alone does not prove tool execution.
5. In cleanup, including on failure, delete the created thread with
   `DELETE /threads/<thread-id>` while the server is running, stop and await the
   server process, and call `await mock.close()`. Verify the thread's managed
   workspace and Docker resources were released, and retain cleanup failures in
   the receipt. Remove the temporary helper after recording its commands/results.

This smoke proves built-runtime workspace tool execution; the replay and Docker
acceptance checks above separately prove repair criteria and approval/denial.
Record failures as failures and retain logs; do not substitute a live-model run
for a failed deterministic replay.

### First live run

For a user-authorized first live run, provide `OPENAI_API_KEY` through the existing
host environment convention, run `npm run dev`, and connect the existing
compatible B4 client to `/fix`. Preserve Workbench configuration; add route
selection only where the client supports it. Ask the agent to read `TASK.md`,
reproduce the defect, and prepare a source repair. Inspect `prepareReview`'s diff
and checks, then use the client's ordinary runtime approval control for
`exportForReview`. Approval exports the exact re-verified candidate to
`.b4/code-fixer/review-outbox/`; denial exports nothing. No remote pull request or
push is performed.

## Record provenance and preserve repeat installs

Write installation notes with the source commit, release, scaffold command,
selected app and route, complete copied-file inventory, SHA256 hashes of the
installed files, documented transformations, preserved overrides, Docker scope,
lockfile integrity, exact verification commands, and outcomes. For example,
`shasum -a 256 <installed-file>` records each installed file's hash; include the
marked route, transformed configuration, and resulting lockfile. Keep an explicit
path list so a repeat installation can compare every recorded file before any
update. Separate image/setup time from agent execution time and make no timing
claim without measurements. Preserve later user edits on repeat installation.
