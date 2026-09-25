#!/usr/bin/env node
/**
 * Run a `b4` command only in the software-factory Docker lane.
 *
 * The builder's real `b4 check` runs the Docker provider's preflight, which needs a daemon,
 * and its `b4 build` is only meaningful where its images exist: both belong to ci.yml's
 * software-factory lane, which sets FACTORY_BUILDER_LANE=1. The repository's unfiltered
 * `build` and `check` walk every workspace package with no Docker in hand, and skip this one.
 * The builder has no target file: it checks and builds as it runs, against its manifest
 * directory (FACTORY_BUILDER_MANIFEST_DIR, defaulted by the package's scripts), which may be
 * empty because refusal is per thread, at admission.
 *
 * Deliberately not a shell one-liner: the exit code has to reach turbo unchanged, and a
 * signal has to stay a signal.
 */
import { spawn } from "node:child_process"

const command = process.argv.slice(2)
if (command.length === 0) {
  console.error("in-lane: a command is required, e.g. `node scripts/in-lane.mjs b4 build`")
  process.exit(2)
}

if (process.env.FACTORY_BUILDER_LANE !== "1") {
  console.log(`builder: FACTORY_BUILDER_LANE is not 1; skipping ${command.join(" ")}`)
  process.exit(0)
}

const child = spawn(command[0], command.slice(1), { stdio: "inherit", shell: false })
child.on("error", (error) => {
  console.error(`in-lane: ${error.message}`)
  process.exit(1)
})
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
