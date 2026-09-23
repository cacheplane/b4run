---
description: Install a code-fixing agent with isolated Docker workspaces, independent verification, and approval-gated local export.
website: https://github.com/cacheplane/b4run/tree/bfaf0c2b3030eebb572703c8f70f0e063593b1fa/examples/code-fixer
version: 1
tags: [agents, code-fixer, docker, evaluation, approval]
source: official
---

# Code-fixer agent

You are a coding agent installing the qualified code-fixer example as ordinary
B4.run application files. `b4 add code-fixer` prints this guide; it does not
install dependencies or run the application. Apply it within the user's requested
installation scope.

Use source commit **`bfaf0c2b3030eebb572703c8f70f0e063593b1fa`** from
`cacheplane/b4run` and published B4 package release **`0.10.0`** throughout.
Do not substitute a branch, `latest`, workspace links, or another package release.
The [pinned example](https://github.com/cacheplane/b4run/tree/bfaf0c2b3030eebb572703c8f70f0e063593b1fa/examples/code-fixer)
is the implementation authority. Copy its files; do not handwrite a second agent.
The example repairs one historical CLI defect. Its tests use scripted model
responses. They do not measure live-model repair quality.

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
a user-authorized live-model run, not for the verification below.

For a new app, select an unused target outside an existing package workspace unless
that workspace's dependency policy can preserve the exact release. Replace
`<new-target>` with that path and use the supported public scaffold:

```sh
npm exec --yes --package=create-b4-app@0.10.0 -- create-b4-app <new-target> --template basic --dist-tag 0.10.0
```

Here `--dist-tag 0.10.0` writes literal `0.10.0` B4 dependency specifiers. Do not
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
B4_CODE_FIXER_REV=bfaf0c2b3030eebb572703c8f70f0e063593b1fa
B4_CODE_FIXER_SOURCE=$(mktemp -d)
git -C "$B4_CODE_FIXER_SOURCE" init --quiet
git -C "$B4_CODE_FIXER_SOURCE" remote add origin https://github.com/cacheplane/b4run.git
git -C "$B4_CODE_FIXER_SOURCE" fetch --depth=1 origin "$B4_CODE_FIXER_REV"
test "$(git -C "$B4_CODE_FIXER_SOURCE" rev-parse FETCH_HEAD)" = "$B4_CODE_FIXER_REV"
git -C "$B4_CODE_FIXER_SOURCE" ls-tree -r --name-only "$B4_CODE_FIXER_REV" -- examples/code-fixer/server
B4_CODE_FIXER_EXTRACT=$(mktemp -d)
git -C "$B4_CODE_FIXER_SOURCE" archive "$B4_CODE_FIXER_REV" \
  examples/code-fixer/server | tar -xf - -C "$B4_CODE_FIXER_EXTRACT"
```

Verify the command results and inventory before copying. The table is the complete
installation allowlist, relative to the pinned repository; everything else in
the extracted server tree is reference material only. Copy directory entries
recursively, including hidden files such as `.gitkeep`.

| Source | Destination/use |
|---|---|
| `examples/code-fixer/server/src/app/fix/**` | `src/app/fix/`: route, tools, skill, plan, and eval |
| `examples/code-fixer/server/src/project/**` | `src/project/`: sample source declaration and workspace policy |
| `examples/code-fixer/server/src/review/**` | `src/review/`: candidate validation, verification, export |
| `examples/code-fixer/server/sample/**` | `sample/`: exact historical project, manifest, task, reference repair, host-only checks |
| `examples/code-fixer/server/workspace/.gitkeep` | `workspace/.gitkeep`: workspace capability discovery |
| `examples/code-fixer/server/scripts/prepare.ts` | `scripts/prepare.ts`: prepared dependency image build |
| `examples/code-fixer/server/test/**` | `test/`: unit and Docker acceptance checks |
| `examples/code-fixer/server/vitest.config.ts` | Unit-test configuration |
| `examples/code-fixer/server/vitest.sandbox.config.ts` | Docker-test configuration |
| `examples/code-fixer/server/Dockerfile` | Prepared dependency image recipe |
| `examples/code-fixer/server/.dockerignore` | Exact prepared-image context allowlist |
| `examples/code-fixer/server/b4.config.ts` | Reviewed app-global configuration; merge only into a compatible app |
| `examples/code-fixer/server/package.json` | Dependency and script reference; merge as below |
| `examples/code-fixer/server/tsconfig.json` | Self-contained compiler configuration; apply as below |
| `examples/code-fixer/server/.env.example` | Environment reference; merge without touching populated secrets |

Do not copy `biome.json` or the `lint` command. They serve the monorepo. The
README, walkthrough, and changelog are reference material. Do not copy
`node_modules`, `.b4`, generated artifacts, credentials, or an existing `.env`.
Keep the sample project inventory exact, including its own `package-lock.json`.
Do not install dependencies inside `sample/project`. Image preparation installs
them. The reference repair and independent checks must remain host-only, outside
captured agent source and the prepared image. Retain the exact `.dockerignore`
allowlist; if an existing app's Docker context conflicts, use a sibling app.

## Apply the standalone transformations

1. Merge `package.json`, preserving the app's name, metadata, compatible extra
   dependencies, and overrides. Pin runtime packages `@b4run/cli`, `@b4run/sdk`,
   `@b4run/sandbox`, and `@b4run/workspace` to literal `0.10.0`. Pin development
   packages `@b4run/testing` and `@b4run/evals` to literal `0.10.0` too. Keep any
   scaffold B4 packages at that same exact release. Use the pinned source's exact
   non-B4 dependency versions where dependencies are added. Skip `@biomejs/biome`,
   which serves only the omitted `lint` command. Resolve incompatible existing
   requirements through a sibling app, never by silently deleting overrides or
   mixing unqualified B4 versions. Do not copy `workspace:*` specifiers.
2. Use the example's `tsconfig.json` as the app's compiler configuration. It does
   not extend a shared package. Preserve its include list,
   `allowImportingTsExtensions`, `exactOptionalPropertyTypes`, NodeNext imports,
   and JSON-module support. In a fresh scaffold, it replaces the scaffold's
   `tsconfig.json`. The scaffold's `@b4run/config-typescript` dependency may remain.
   Existing compiler conflicts require a sibling app or separately reviewed
   integration.
3. Register `dev: b4 dev`, `check: b4 check`, `build: b4 build`,
   `start: node .b4/build/server.mjs`, and `eval: b4 eval`. Copy the source commands
   for `typecheck`, `test`, `sandbox:prepare`, and `test:sandbox`. Omit the
   repository-only `lint` command; retain the destination's existing lint command
   if present. Fresh scaffold demo commands may be replaced deliberately; for
   pre-existing app script conflicts use documented namespaced commands and adjust
   every verification command accordingly. Keep live evaluation separate from
   normal startup.
4. Review `b4.config.ts` before applying it. Preserve network denial, resource
   limits, read-only prepared dependencies, and approval-gated export. Replace the
   example's `code-fixer-local` Docker scope with a stable installation-specific
   scope, or retain an existing reviewed compatible scope. The prepared image tag
   `b4-code-fixer:fixture-v1` is fixed in `src/project/workspace.ts`, so
   installations on one host share it. Preserve explicit compatible
   model/environment conventions. `B4_CODE_FIXER_MODEL` selects the model, and
   `gpt-5-mini` is the default. Never put host API keys in the sandbox
   environment. Merge ignore rules for `.b4`, `artifacts`, `.env`, and `.env.*`,
   retaining an exception for `.env.example` and existing user rules.
5. Add this first line to the copied primary route `src/app/fix/index.ts`:

   ```ts
   // b4-blueprint: code-fixer@1
   ```

   Make no other agent, tool, sample, or test implementation edits. Record hashes
   after this documented marker addition and the configuration transformations.
   Record user-specific configuration choices separately from the pinned source.
6. Install with the detected package manager, review its lockfile, and retain it
   with the installation. The scaffold lockfile must be refreshed after merging
   dependencies; do not use a frozen install against the old scaffold graph.
   Do not copy the monorepo lockfile or overwrite the sample's lockfile. Record
   exact resolved versions and package integrity, then verify a subsequent frozen
   install (`npm ci`, `pnpm install --frozen-lockfile`, or the detected equivalent).

## Verify the installation

Run from the standalone app directory, using the detected package manager and any
recorded namespaced script equivalents. For npm:

```sh
npm install
npm ci
npm run sandbox:prepare
npm run check
npm run build
npm run typecheck
npm test
npm run test:sandbox
```

`sandbox:prepare` pulls `node:24-slim` and builds the prepared dependency image.
If the pull cannot complete, record the failure. Do not edit the script.
`npm test` runs the focused unit tests. `npm run test:sandbox` runs the Docker
acceptance tests. They drive the agent through the checked-in reference repair
with scripted model responses. They require all six repair criteria and exercise
both an approved export and a denied export. They make no paid model calls.
These are standalone app checks. The contributor monorepo CI sequence is not an
installation prerequisite.

### Exercise the built HTTP runtime without a model key

The tests above do not exercise the built HTTP server. Use a temporary host-only
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
3. Wait for a successful `GET /healthz` on that loopback server. Create a thread
   with `POST /threads`, JSON body `{}`, and retain its returned `thread_id`.
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

   Require a successful run containing the `readFile` tool result with the task
   text from `sample/task.md` and the final response
   `Qualification task read through the managed workspace.`. A successful build
   or health response alone does not prove tool execution.
5. In cleanup, including on failure, delete the created thread with
   `DELETE /threads/<thread-id>` while the server is running, stop and await the
   server process, and call `await mock.close()`. Verify the thread's managed
   workspace and Docker resources were released, and retain cleanup failures in
   the receipt. Remove the temporary helper after recording its commands/results.

This smoke proves built-runtime workspace tool execution. The Docker acceptance
tests above separately prove repair criteria and approval/denial. Record failures
as failures and retain logs. Do not substitute a live-model run for a failed
deterministic check.

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
