import { resolvePin } from "../src/lib/intake/issue.js"
import { appRoot, repositoryRoot, targetsDir } from "../src/lib/targets/catalog.js"
import { initTarget, parseInitArgs, resolveTargetsDir } from "../src/lib/targets/init/init.js"
import { renderDiff, writeProposal } from "../src/lib/targets/proposal.js"

/**
 * Generate a target for a pnpm workspace package: `targets/<id>/target.json` and its
 * `Dockerfile`, derived from the package's manifests at a pin read from the object store.
 *
 * `target-init.ts <package name or directory> [--pin <sha>] [--id <id>] [--targets-dir <dir>]
 * [--with-dev-builds] [--write]`
 *
 * Prints the proposal as a unified diff against what is on disk (stdout) and its notes
 * (stderr); writes only with --write. The pin defaults to origin/main, as `create --issue`
 * pins (FACTORY_NO_FETCH=1 reads the checkout's origin/main without fetching). --targets-dir
 * proposes into another catalog (a scratch measurement) instead of the controller's; a relative
 * one is relative to the directory `pnpm target:init` was run from (pnpm's INIT_CWD), else the
 * process's own. A refusal prints as one `target:init:` line and exits 1. A target
 * is an oracle input: the person reviews the diff and commits it; run target:measure first.
 */
try {
  const args = parseInitArgs(process.argv.slice(2))
  const catalog =
    args.targetsDir === undefined
      ? targetsDir
      : resolveTargetsDir(args.targetsDir, process.env, process.cwd())
  const repo = repositoryRoot()
  const pin =
    args.pin ??
    (await resolvePin({ repositoryRoot: repo, fetch: process.env.FACTORY_NO_FETCH !== "1" }))
  const result = initTarget({
    packageRef: args.packageRef,
    pin,
    repositoryRoot: repo,
    targetsDir: catalog,
    ...(args.id !== undefined ? { id: args.id } : {}),
    ...(args.withDevBuilds ? { withDevBuilds: true } : {}),
  })
  process.stdout.write(renderDiff(result.files, args.targetsDir === undefined ? appRoot : catalog))
  process.stderr.write(`target:init: ${result.id} at ${pin}\n`)
  for (const note of result.notes) process.stderr.write(`target:init: ${note}\n`)
  if (args.write)
    for (const path of writeProposal(result.files))
      process.stderr.write(`target:init: wrote ${path}\n`)
  else
    process.stderr.write(
      "target:init: nothing written; --write writes the files above, and git diff is the review\n",
    )
} catch (error) {
  // A refusal is the answer, not a crash: one line, exit 1.
  process.stderr.write(`target:init: ${(error as Error).message}\n`)
  process.exitCode = 1
}
