import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { appRoot, repositoryRoot, TargetSchema, targetsDir } from "../src/lib/targets/catalog.js"
import { dockerImageBuilder } from "../src/lib/targets/image-builder.js"
import {
  ImagePrepareError,
  type ImageRegistry,
  openImageRegistry,
} from "../src/lib/targets/images.js"
import { resolveTargetsDir } from "../src/lib/targets/init/init.js"
import { MeasureError, outputTail, sanitize } from "../src/lib/targets/measure/classify.js"
import { measureTarget, parseMeasureArgs } from "../src/lib/targets/measure/measure.js"
import { renderDiff, writeProposal } from "../src/lib/targets/proposal.js"

/**
 * Measure a target in its own image and propose its excludes and resources.
 *
 * `target-measure.ts <id> [--pin <sha>] [--targets-dir <dir>] [--write] [--allow-decrease]
 * [--runs <n>] [--file-timeout-ms <ms>] [--memory-mb <mb>] [--cpus <n>]`
 *
 * Builds (or re-verifies) the target's image through <FACTORY_STATE_DIR>/images.sqlite, as the
 * controller does; runs each test file alone with the network denied (each non-pass twice),
 * then the proposed suite --runs times in fresh containers and once at the proposed resources.
 * Prints the proposal (target.json and measurement.md) as a diff on stdout, writes the full
 * evidence to <FACTORY_STATE_DIR>/measurements/<id>/<pin12>-<utc>/report.md (a partial one
 * when it stops after the per-file phase), and writes the target only with --write. Resources
 * never fall below the target's own without --allow-decrease. A build that fails at the
 * Dockerfile's promotion check proposes the set it printed instead; apply it and run again.
 * A relative --targets-dir is relative to where `pnpm target:measure` was run (INIT_CWD). A
 * refusal prints as one `target:measure:` line (after any output it quotes, sanitised) and
 * exits 1.
 */
const log = (line: string) => process.stderr.write(`target:measure: ${line}\n`)
let registry: ImageRegistry | undefined
try {
  const stateDir = process.env.FACTORY_STATE_DIR
  if (!stateDir)
    throw new Error(
      "FACTORY_STATE_DIR is required: the image is built into <FACTORY_STATE_DIR>/images.sqlite, and the captures and the report are staged under it",
    )
  const args = parseMeasureArgs(process.argv.slice(2))
  const catalog =
    args.targetsDir === undefined
      ? targetsDir
      : resolveTargetsDir(args.targetsDir, process.env, process.cwd())
  const reportPath = (pin: string) => {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z")
    const path = join(
      resolve(stateDir),
      "measurements",
      args.id,
      `${pin.slice(0, 12)}-${stamp}`,
      "report.md",
    )
    mkdirSync(dirname(path), { recursive: true })
    return path
  }
  /** The pin a stopped measurement ran at: --pin, else the target's default. */
  const measuredPin = () => {
    if (args.pin !== undefined) return args.pin
    try {
      const manifest = readFileSync(join(catalog, args.id, "target.json"), "utf8")
      return TargetSchema.parse(JSON.parse(manifest)).pin
    } catch {
      return "unknown-pin"
    }
  }
  registry = openImageRegistry({
    path: join(stateDir, "images.sqlite"),
    builder: dockerImageBuilder(),
  })
  const interrupted = new AbortController()
  process.once("SIGINT", () => interrupted.abort(new Error("interrupted")))
  try {
    const outcome = await measureTarget({
      id: args.id,
      targetsDir: catalog,
      repositoryRoot: repositoryRoot(),
      registry,
      stagingRoot: resolve(stateDir),
      signal: interrupted.signal,
      fileTimeoutMs: args.fileTimeoutMs,
      memoryMb: args.memoryMb,
      runs: args.runs,
      allowDecrease: args.allowDecrease,
      log,
      ...(args.pin !== undefined ? { pin: args.pin } : {}),
      ...(args.cpus !== undefined ? { cpus: args.cpus } : {}),
    })
    process.stdout.write(
      renderDiff(outcome.files, args.targetsDir === undefined ? appRoot : catalog),
    )
    if (outcome.kind === "promotion") {
      log(
        `the build promoted [${outcome.promoted.join(" ")}] over the root's node_modules, which the Dockerfile does not declare: review the diff above (a promotion replaces a package every other package resolves)`,
      )
      if (args.write) {
        for (const path of writeProposal(outcome.files)) log(`wrote ${path}`)
        log("run target:measure again")
      } else log("--write applies it; then run target:measure again")
      process.exitCode = 1
    } else {
      const report = reportPath(outcome.pin)
      writeFileSync(report, outcome.report)
      log(`report: ${report}`)
      if (args.write) for (const path of writeProposal(outcome.files)) log(`wrote ${path}`)
      else log("nothing written; --write writes the proposal above, and git diff is the review")
    }
  } catch (error) {
    // The evidence first (sanitised: it is test and build output), then the one-line refusal.
    if (error instanceof MeasureError) {
      if (error.output !== "") process.stderr.write(`${outputTail(error.output)}\n`)
      if (error.report !== undefined) {
        const report = reportPath(measuredPin())
        writeFileSync(report, error.report)
        log(`stopped; partial report: ${report}`)
      }
    }
    if (error instanceof ImagePrepareError) process.stderr.write(`${outputTail(error.log)}\n`)
    throw error
  }
} catch (error) {
  // A refusal is the answer, not a crash: one line, exit 1.
  log(sanitize((error as Error).message).replaceAll("\n", " "))
  process.exitCode = 1
} finally {
  registry?.close()
}
