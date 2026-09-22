#!/usr/bin/env node
/**
 * Run a `b4` command only when this builder has a manifest.
 *
 * The builder's `b4.config.ts` is a function of ONE input, FACTORY_BUILDER_MANIFEST, and it
 * refuses to load without it. That is right for the builder and wrong for the repository's
 * unfiltered `build` and `check`, which walk every workspace package and have no task in
 * hand: without this guard the whole graph fails on a package that cannot be built out of
 * context. The REAL `b4 check` and `b4 build` run in ci.yml's software-factory Docker lane
 * and nowhere else: that job writes a `cli-flags` manifest with `factory builder-manifest`
 * and runs both commands with FACTORY_BUILDER_MANIFEST pointing at it.
 *
 * Deliberately not a shell one-liner: the exit code has to reach turbo unchanged, and a
 * signal has to stay a signal.
 */
import { spawn } from "node:child_process"

const command = process.argv.slice(2)
if (command.length === 0) {
  console.error(
    "with-manifest: a command is required, e.g. `node scripts/with-manifest.mjs b4 build`",
  )
  process.exit(2)
}

if (!process.env.FACTORY_BUILDER_MANIFEST) {
  console.log(`builder: FACTORY_BUILDER_MANIFEST is not set; skipping ${command.join(" ")}`)
  process.exit(0)
}

const child = spawn(command[0], command.slice(1), { stdio: "inherit", shell: false })
child.on("error", (error) => {
  console.error(`with-manifest: ${error.message}`)
  process.exit(1)
})
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
