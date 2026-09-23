#!/usr/bin/env node
/**
 * Run a `b4` command only when this builder has a target.
 *
 * The builder's `b4.config.ts` is a function of TWO inputs: FACTORY_BUILDER_TARGET, the one
 * target this process serves (its provider, policy and permissions), and
 * FACTORY_BUILDER_MANIFEST_DIR, where the controller writes one manifest per work order. It
 * refuses to load without either. The directory may be empty (refusal is per thread, at
 * resolve time), and the package's `check`/`build` scripts default it; the target has no
 * default, so it is what this guard decides on. That is right for the builder and wrong for
 * the repository's unfiltered `build` and `check`, which walk every workspace package and have
 * no target in hand: without this guard the whole graph fails on a package that cannot be
 * built out of context. The REAL `b4 check` and `b4 build` run in ci.yml's software-factory
 * Docker lane and nowhere else: that job writes the `cli-flags` target with
 * `factory builder-target` and runs both commands with FACTORY_BUILDER_TARGET pointing at it.
 *
 * Deliberately not a shell one-liner: the exit code has to reach turbo unchanged, and a
 * signal has to stay a signal.
 */
import { spawn } from "node:child_process"

const command = process.argv.slice(2)
if (command.length === 0) {
  console.error("with-target: a command is required, e.g. `node scripts/with-target.mjs b4 build`")
  process.exit(2)
}

if (!process.env.FACTORY_BUILDER_TARGET) {
  console.log(`builder: FACTORY_BUILDER_TARGET is not set; skipping ${command.join(" ")}`)
  process.exit(0)
}

const child = spawn(command[0], command.slice(1), { stdio: "inherit", shell: false })
child.on("error", (error) => {
  console.error(`with-target: ${error.message}`)
  process.exit(1)
})
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
