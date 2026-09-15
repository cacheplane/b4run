# Code-fixer installation guide — unpublished draft

This is a draft for the future `b4 add code-fixer` guide. It is not in the public
blueprint catalog and does not establish a supported registry installation today.
Use the [server README](./server/README.md) to run the current checkout.

The approved delivery sequence requires correcting and verifying the app first,
then publishing this guide against a compatible released library version. Before
using these instructions for a standalone installation, a maintainer must record:

- An exact 40-character source commit containing the corrected app.
- One exact published B4 release that includes managed workspace configuration,
  tool workspace provenance and file metadata, `withWorkspace`, and evaluation
  cleanup APIs.
- Successful clean-directory qualification with that commit and release,
  including exact commands and the resulting check, build, replay, approval,
  and built-runtime outcomes.

These values remain unset. Do not substitute `main`, `latest`, a development
checkout, or workspace links and call the result published-package qualification.
Do not publish the guide until the missing evidence exists. Publication also
requires the planned `agents` catalog category and blueprint route/catalog tests.

## Instructions for the installing coding agent

The finished `b4 add` command prints instructions; it does not install packages or
run the application itself. Apply this guide to the user's app only within the
requested installation scope.

1. Inspect the destination before changing it. Identify its package manager and
   lockfile, workspace layout, existing B4 app and routes, environment conventions,
   TypeScript settings, client/Workbench integration, and current package versions.
   Look for a previous code-fixer installation and its provenance record. If it
   exists, compare source files with the recorded revision and preserve user edits;
   do not overwrite or silently reinstall it.
2. Prefer a separate sibling B4 app when adding to an existing project. Sandbox
   providers and permissions are app-global. Reuse an existing app only when its
   Docker workspace configuration, durable storage, permissions, and route naming
   are demonstrably compatible. Explain a conflict and use a sibling app by
   default. A deliberate shared-app migration needs separate review. Preserve
   unrelated routes, Workbench configuration, environment files, dependencies,
   package-manager overrides/resolutions, and runtime configuration overrides.
3. Require Node 24, Git, and running Docker. For a new app, use the supported
   `create-b4-app` path from the selected compatible release. Use the detected
   package manager throughout and retain its lockfile. Do not use the monorepo's
   internal scaffold mode.
4. Fetch only the following source from the recorded commit in
   `cacheplane/b4run`. Validate the commit and file inventory before applying it.
   Never execute a fetched shell script or duplicate the agent implementation
   manually. Paths below are relative to that repository:

   | Source | Destination/use |
   |---|---|
   | `examples/code-fixer/server/src/app/fix/**` | Ordinary `/fix` route, tools, skill, plan, and eval |
   | `examples/code-fixer/server/src/fixtures/**` | Trusted fixture catalog and workspace descriptor |
   | `examples/code-fixer/server/src/review/**` | Candidate validation, independent verification, local export |
   | `examples/code-fixer/server/src/evaluation/**` | Replay and batch evaluation support |
   | `examples/code-fixer/server/fixtures/**` | Exact historical source, manifests, task text, reference patches, and host-only checks |
   | `examples/code-fixer/server/workspace/.gitkeep` | Workspace capability discovery marker |
   | `examples/code-fixer/server/b4.config.ts` | Reviewed app configuration; merge only into a compatible app |
   | `examples/code-fixer/server/Dockerfile` | Prepared dependency image recipe |
   | `examples/code-fixer/server/scripts/{prepare,qualify,eval,attempt-worker,export}.ts` | Image, qualification, replay, and evidence commands |
   | `examples/code-fixer/server/test/**` and `vitest*.config.ts` | Unit and Docker acceptance checks |
   | `examples/code-fixer/server/package.json`, `tsconfig.json`, `.env.example` | Configuration references; merge carefully |
   | `packages/config-typescript/{base,library,node}.json` | Standalone `config/` compiler settings if the scaffold lacks equivalent settings |

   Do not copy `node_modules`, `.b4`, generated artifacts, credentials, or an
   existing `.env`. Keep fixture project inventories exact; do not install
   dependencies into their source directories. The image preparation step installs
   the fixture dependencies. Reference repairs and independent checks must remain
   on the host and outside captured agent source and the prepared image.
5. Merge package metadata rather than replacing it. Pin the four runtime packages
   `@b4run/cli`, `@b4run/sdk`, `@b4run/sandbox`, and `@b4run/workspace` to the recorded
   release. Pin `@b4run/testing` and `@b4run/evals` to the same release for evaluation.
   Preserve existing compatible dependencies and overrides; report conflicts
   rather than removing an override to force installation. Use the source
   package's exact non-B4 dependency versions where new dependencies are needed.
   Remove `workspace:*` references from the standalone app. Do not depend on the
   repository-only TypeScript or Biome configuration paths: use the scaffold's
   equivalent settings or the bounded configuration files above. Preserve
   `exactOptionalPropertyTypes`, NodeNext imports, and JSON-module support.
6. Register the ordinary `dev: b4 dev`, `check: b4 check`, `build: b4 build`,
   `start: node .b4/build/server.mjs`, and `eval: b4 eval` commands without
   overwriting existing commands. Where names conflict, use documented namespaced
   script names. Add the source app's image preparation, replay, unit, and Docker
   test commands. Keep live-evaluation commands separate from normal startup.
7. Review the copied `b4.config.ts`. Retain network denial, resource limits,
   read-only prepared dependencies, and approval-gated export. Choose a stable
   installation-specific Docker scope; preserve an existing reviewed compatible
   scope. The CLI fixture remains the default. A trusted host setting
   `B4_CODE_FIXER_TASK=nullable-inputs` selects the alternative for new workspaces.
   Preserve existing model/environment conventions; `gpt-5-mini` is the default
   only where no explicit compatible choice exists. Never put host API keys in
   the sandbox environment. Ignore `.b4`, evaluation artifacts, and local secret
   files in version control.

## Verify the installation

Use the detected package manager's equivalents of the following commands from
the standalone app directory. These are app checks, not the monorepo CI sequence:

```sh
pnpm install
pnpm run sandbox:prepare
pnpm run check
pnpm run build
pnpm run typecheck
pnpm test
pnpm run eval:replay
pnpm run test:sandbox
```

Both replay fixtures must pass all six criteria and stop at `approval-pending`.
Replay uses historical patches and makes no paid model calls. Docker acceptance
must demonstrate actual approve/resume and denial, independent verification,
and killed-verifier cleanup. Also run the built Node entry with `pnpm start`
and verify its runtime route; a successful build alone is insufficient. Record
failures as failures and retain their logs. Do not silently substitute a live
model run for a failed replay or claim local workspace packages are registry
packages.

For a user-authorized first live run, provide `OPENAI_API_KEY` through the existing
host environment convention, run `pnpm dev`, and connect the existing compatible
B4 client to `/fix`. Preserve Workbench configuration; add a route selection only
where the client supports it. Ask the agent to read TASK.md, reproduce the defect,
and prepare a source repair. Inspect `prepareReview`'s diff and checks, then use
the client's ordinary runtime approval control for `exportForReview`. Approval
exports the exact re-verified candidate to `.b4/code-fixer/review-outbox/`; denial
exports nothing. There is no remote pull request or push.

Finally, record the source commit, package release, copied-file hashes, selected
app/route, preserved overrides, and exact verification commands in the
installation notes. Separate image/setup time from agent execution time and make
no timing claim without measurements. A repeat installation must consult those
notes and preserve later user edits.
