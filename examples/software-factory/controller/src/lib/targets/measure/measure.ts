import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { isWorkspaceInspectionError } from "@b4run/workspace"
import { gradeVitestReport } from "../../verification/checks-runner.js"
import { commitSha, loadTargetRecipe, type TargetRecipe, TargetSchema } from "../catalog.js"
import { type EnsuredImage, ImagePrepareError, type ImageRegistry } from "../images.js"
import { isPlaceholderResources } from "../init/derive.js"
import { expectedPromotedOf, promotionMismatch, withExpectedPromoted } from "../init/dockerfile.js"
import { gitPinTree } from "../init/pin-tree.js"
import { type FileProposal, formatManifest, readIfPresent } from "../proposal.js"
import {
  listArgv,
  packagePath,
  parseVitestCommand,
  perFileArgv,
  withExcludes,
} from "../vitest-command.js"
import {
  changedPaths,
  classifyFile,
  coveringDeadline,
  EXCLUDED,
  type FileMeasurement,
  hasControl,
  MeasureError,
  type Measurement,
  outputTail,
  proposeResources,
  type Resources,
  renderFiles,
  renderMeasurementRecord,
  renderReport,
  type SuiteSample,
  sanitize,
  settleFile,
  settleResources,
} from "./classify.js"
import {
  dockerSessions,
  type MeasureSession,
  type OpenSession,
  type SessionLimits,
  withoutProject,
} from "./session.js"

/**
 * What the session listed, as files to run alone: without vitest's `[<project>] ` prefix,
 * de-duplicated and sorted. Anything but a plain path relative to the command directory is the
 * harness's failure: vitest reads a per-file argument as a filter.
 */
function listedFiles(listed: readonly string[]): string[] {
  const files = [...new Set(listed.map((name) => withoutProject(name.trim())))].sort()
  for (const file of files) {
    if (hasControl(file))
      throw new MeasureError(
        `vitest listed ${JSON.stringify(file)}, whose name holds a control character: it would reach the report and measurement.md as it is`,
      )
    if (
      file === "" ||
      file.startsWith("/") ||
      file.startsWith("-") ||
      file.split("/").includes("..")
    )
      throw new MeasureError(
        `vitest listed ${JSON.stringify(file)}; a measured file is a path relative to the command directory`,
      )
  }
  return files
}

export interface MeasureSuiteOptions {
  readonly recipe: Pick<TargetRecipe, "id" | "commands">
  readonly open: OpenSession
  readonly fileTimeoutMs: number
  readonly memoryMb: number
  readonly cpus: number
  readonly runs: number
  /** The target's resources before this measurement; undefined when they are placeholders. */
  readonly prior?: Resources
  /** Propose below `prior` when the measurement says so (plan D12). */
  readonly allowDecrease: boolean
  /** Does a repository path exist at the measured pin? Names capture omissions (plan D11). */
  readonly existsAtPin?: (path: string) => boolean
  readonly log?: (line: string) => void
  readonly now?: () => number
}

/** What a session's limits are called in a refusal: the options, unless said otherwise. */
const MEASUREMENT_LIMITS = "the measurement's limits (--memory-mb, --file-timeout-ms)"

async function buildOrThrow(session: MeasureSession, limitsName: string = MEASUREMENT_LIMITS) {
  const build = await session.build()
  // 124 is the sandbox's per-command timeout, 137 a kill (the memory limit): the limits, not
  // the target, are what the build did not fit.
  if (build.exitCode === 124 || build.exitCode === 137)
    throw new MeasureError(
      `The target's build exceeded ${limitsName} (exit ${build.exitCode}: ${build.exitCode === 124 ? "timed out" : "killed, likely out of memory"})`,
      build.output,
    )
  if (!build.ok)
    throw new MeasureError(
      "The target's build fails in its own image: a defect of the target (its Dockerfile, capture or build command) to fix before anything is measured, not a test to exclude",
      build.output,
    )
  return build
}

/**
 * The inspection's refusal (`refused`: an executable, binary or non-UTF-8 file, an unexpected
 * link, a limit exceeded), as one sanitised JSON-quoted line: the verifier's tamper check
 * inspects with the same options, so it refuses the same workspace on every verification.
 */
function refusalOf(error: unknown): string | undefined {
  if (!isWorkspaceInspectionError(error) || error.code !== "refused") return undefined
  return JSON.stringify(sanitize(error.message).replace(/\s+/g, " ").trim())
}

/**
 * `session`'s workspace as the verifier's tamper check sees it; `where` says when, for a
 * snapshot that fails. A refusal is returned for the caller to classify; anything else the
 * inspection throws (an I/O error, a workspace changing while read) stops the measurement.
 */
async function snapshotOf(
  session: MeasureSession,
  where: string,
): Promise<{ readonly files: Readonly<Record<string, string>> } | { readonly refusal: string }> {
  try {
    return { files: await session.snapshot() }
  } catch (error) {
    const refusal = refusalOf(error)
    if (refusal !== undefined) return { refusal }
    if (error instanceof MeasureError || (error instanceof Error && error.name === "AbortError"))
      throw error
    throw new MeasureError(
      `The workspace snapshot ${where} failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** The workspace right after a session's build, before any test ran: a refusal is the target's. */
async function baseline(
  session: MeasureSession,
  id: string,
): Promise<Readonly<Record<string, string>>> {
  const snapshot = await snapshotOf(session, "after the build")
  if ("refusal" in snapshot)
    throw new MeasureError(
      `the verifier's workspace inspection refuses ${id}'s workspace after its build, before any test ran: ${snapshot.refusal}. Every verification of the target would be refused; fix the target (its build, capture or Dockerfile) before it is measured`,
    )
  return snapshot.files
}

/**
 * One file alone in `session`, the workspace snapshotted before (`before`, when the caller
 * has it) and after with the verifier's options. A workspace the inspection refuses after the
 * run is the file's doing: `writes`, whatever else the run said (plan D11).
 */
async function measureFile(
  session: MeasureSession,
  file: string,
  argv: readonly string[],
  options: MeasureSuiteOptions,
  before?: Readonly<Record<string, string>>,
): Promise<FileMeasurement> {
  const start =
    before ??
    (await (async () => {
      const snapshot = await snapshotOf(session, `before ${file}`)
      if ("refusal" in snapshot)
        throw new MeasureError(
          `the verifier's workspace inspection refuses the workspace before ${file} ran, after its session's previous file passed without changing it: ${snapshot.refusal}. Something the previous file left running changed it`,
        )
      return snapshot.files
    })())
  const run = await session.vitest(argv)
  const after = await snapshotOf(session, `after ${file}`)
  if ("files" in after)
    return classifyFile(file, run, changedPaths(start, after.files), options.existsAtPin)
  const alone = classifyFile(file, run, [], options.existsAtPin)
  return {
    ...alone,
    verdict: "writes",
    reason: [
      `the verifier's workspace inspection refuses the workspace after it: ${after.refusal}`,
      ...(alone.verdict === "pass" ? [] : [alone.reason]),
    ].join("; "),
    output: outputTail(run.output),
  }
}

/**
 * Why the verifier's grader (`gradeVitestReport`, with no expected names, as a generated
 * task's visible suite is graded) would not pass a run that exited 0; undefined if it would.
 * A missing report, or a suite whose files are all skipped or todo, exits 0 and is graded
 * `inconclusive` on every verification: a proposal for it holds nothing.
 */
function notGradedPass(exitCode: number, report: string): string | undefined {
  if (gradeVitestReport(exitCode, report, []).verdict === "pass") return undefined
  if (report.trim() === "") return "it wrote no JSON report"
  let parsed: unknown
  try {
    parsed = JSON.parse(report)
  } catch {
    return "its JSON report is not a vitest report"
  }
  const r = parsed as { numTotalTests?: unknown; numFailedTests?: unknown; testResults?: unknown }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(r.testResults))
    return "its JSON report is not a vitest report"
  if (typeof r.numTotalTests !== "number" || typeof r.numFailedTests !== "number")
    return "its JSON report has no test totals"
  if (r.numFailedTests > 0) return "its JSON report names a failed test though it exited 0"
  return "no test passed in it (none was selected, or every test was skipped or todo)"
}

/** The whole `test` in a fresh session at `limits`: a sample, or a stop with the suite's output. */
async function sampleSuite(
  id: string,
  open: OpenSession,
  limits: SessionLimits,
  test: readonly string[],
  now: () => number,
  what: string,
  limitsName?: string,
): Promise<SuiteSample> {
  const started = now()
  const sample = await open(limits, async (session) => {
    const build = await buildOrThrow(session, limitsName)
    const before = await baseline(session, id)
    const suite = await session.vitest(test)
    const after = await snapshotOf(session, "after the suite")
    const changed = "files" in after ? changedPaths(before, after.files) : []
    const failure = suite.timedOut
      ? `did not finish within ${limits.commandTimeoutMs} ms`
      : suite.exitCode !== 0
        ? `failed (exit ${suite.exitCode})`
        : "refusal" in after
          ? `left a workspace the verifier's inspection refuses (${after.refusal}), so every verification would be refused,`
          : changed.length > 0
            ? `changed the workspace (${changed.slice(0, 10).join(", ")})`
            : (() => {
                const why = notGradedPass(suite.exitCode, suite.report)
                return why === undefined
                  ? undefined
                  : `exited 0, but the verifier would not grade it a pass: ${why};`
              })()
    if (failure !== undefined)
      throw new MeasureError(
        `The suite with the proposed excludes ${failure} ${what}`,
        suite.output,
      )
    return {
      buildMs: build.ms,
      suiteMs: suite.ms,
      memoryPeakBytes: await session.memoryPeakBytes(),
    }
  })
  return { ...sample, sessionMs: Math.round(now() - started) }
}

/**
 * Every file the target's vitest command lists, run alone in the verifier's session shape and
 * classified; each non-pass run once more in a fresh container (plan D11). Then the whole suite
 * with the proposed excludes, `runs` times in fresh containers, for the measured resources, and
 * once more at the resources proposed (plan D12). Throws `MeasureError`, proposing nothing,
 * when the fault is the harness's or the target's rather than a file's; after the per-file
 * phase the error carries the files measured, for a partial report.
 */
export async function measureSuite(options: MeasureSuiteOptions): Promise<Measurement> {
  const { recipe, open } = options
  const log = options.log ?? (() => {})
  const now = options.now ?? (() => performance.now())
  const command = parseVitestCommand(recipe.commands.test)
  const limits = {
    memoryMb: options.memoryMb,
    cpus: options.cpus,
    commandTimeoutMs: options.fileTimeoutMs,
  }

  // The listing, in a session of its own: whatever `vitest list` leaves behind (in the
  // workspace, /tmp or a process), the first file does not start from it, as no verification
  // runs a listing first.
  const listed = await open(limits, async (session) => {
    await buildOrThrow(session)
    return listedFiles(await session.listFiles(listArgv(command)))
  })
  if (listed.length === 0)
    throw new MeasureError(
      `vitest lists no test file for ${recipe.id}'s command (with --passWithNoTests an empty listing still exits 0): there is nothing to measure`,
    )
  log(`${listed.length} test files`)
  const unexcludable = listed.filter((file) => !packagePath(file))
  if (unexcludable.length > 0)
    log(
      `note: ${unexcludable.map((file) => JSON.stringify(file)).join(", ")} could not be excluded should it not pass: an exclude is written only as a literal path of portable characters`,
    )

  // Phase 1: each file alone. A file that changed the workspace, hung or was killed leaves
  // the container dirty or busy, so the next file gets a fresh one. A file that passed keeps
  // the container: anything it left outside the workspace (a /tmp file, a stray process) is
  // carried to the next file. That is bounded: the workspace itself is compared before and
  // after every file; a later file that fails from the carry-over is run again alone in a
  // fresh container before it is proposed; and the proposed suite is then run whole in fresh
  // containers, as the verifier runs it, so no proposal rests on what one file left another.
  const pending = [...listed]
  const first: FileMeasurement[] = []
  try {
    while (pending.length > 0) await measureQueue()
  } catch (error) {
    // The files measured before the stop, for a partial report.
    if (error instanceof MeasureError && first.length > 0) error.files = [...first]
    throw error
  }
  async function measureQueue() {
    await open(limits, async (session) => {
      await buildOrThrow(session)
      let before: Readonly<Record<string, string>> | undefined = await baseline(session, recipe.id)
      for (let file = pending.shift(); file !== undefined; file = pending.shift()) {
        const result = await measureFile(session, file, perFileArgv(command, file), options, before)
        before = undefined
        first.push(result)
        log(`${result.verdict.padEnd(6)} ${file} (${result.ms} ms)`)
        // `writes` without a change is a workspace the inspection refused after the file.
        if (
          result.changed.length > 0 ||
          result.verdict === "writes" ||
          result.verdict === "hang" ||
          result.verdict === "killed"
        )
          return
      }
    })
  }

  const files: FileMeasurement[] = []
  try {
    // Phase 2: each non-pass once more, alone in a fresh container; a disagreement is flaky.
    for (const result of first) {
      if (result.verdict === "pass") {
        files.push(result)
        continue
      }
      const again = await open(limits, async (session) => {
        await buildOrThrow(session)
        return await measureFile(
          session,
          result.file,
          perFileArgv(command, result.file),
          options,
          await baseline(session, recipe.id),
        )
      })
      const settled = settleFile(result, again)
      files.push(settled)
      log(`${settled.verdict.padEnd(6)} ${result.file} (second run: ${again.verdict})`)
    }

    const excluded = files.filter((m) => EXCLUDED.has(m.verdict))
    for (const m of excluded)
      if (!packagePath(m.file))
        throw new MeasureError(
          `${JSON.stringify(m.file)} (${m.verdict}) cannot be written as a literal --exclude (vitest reads an exclude as a glob; only portable characters are written): rename the file, or narrow the target's test command by hand`,
        )
    const excludes = excluded.map((m) => m.file).sort()
    if (excludes.length === files.length)
      throw new MeasureError(
        `no test file passes run alone (${files.length} measured): there is no suite to propose resources for; read each file's output in the report`,
      )
    const test = withExcludes(command, excludes)

    // Phase 3: the suite, for the measured resources.
    const passingMs = files.filter((m) => m.verdict === "pass").reduce((sum, m) => sum + m.ms, 0)
    const suiteLimits = {
      ...limits,
      commandTimeoutMs: Math.max(options.fileTimeoutMs, 2 * passingMs),
    }
    const samples: SuiteSample[] = []
    for (let run = 1; run <= options.runs; run++) {
      const sample = await sampleSuite(
        recipe.id,
        open,
        suiteLimits,
        test,
        now,
        `on run ${run}: no resources are proposed for a suite that does not pass`,
      )
      samples.push(sample)
      log(`suite run ${run}: ${JSON.stringify(sample)}`)
    }
    const measured = proposeResources(samples, options.cpus)
    // A prior, or --allow-decrease, can pair one side's timeout with the other's deadline: the
    // deadline must still absorb a command timing out in each of the verifier's two sessions.
    const resources = coveringDeadline(
      settleResources(measured, options.prior, options.allowDecrease),
      samples,
    )

    // Phase 4: the proposal, tried. A verification session must also fit twice in the deadline.
    const confirmation = await sampleSuite(
      recipe.id,
      open,
      {
        memoryMb: resources.memoryMb,
        cpus: resources.cpus,
        commandTimeoutMs: resources.commandTimeoutMs,
      },
      test,
      now,
      `at the proposed resources ${JSON.stringify(resources)}: the proposed resources did not hold`,
      `the proposed resources ${JSON.stringify(resources)}; they did not hold`,
    )
    if (2 * confirmation.sessionMs > resources.verifierDeadlineMs)
      throw new MeasureError(
        `A session at the proposed resources took ${confirmation.sessionMs} ms; two of them do not fit the proposed verifierDeadlineMs ${resources.verifierDeadlineMs}: the proposed resources did not hold`,
      )
    log(`confirmed at ${JSON.stringify(resources)}: ${JSON.stringify(confirmation)}`)
    return {
      files,
      excludes,
      test,
      samples,
      measured,
      prior: options.prior,
      resources,
      confirmation,
    }
  } catch (error) {
    // Settled where phase 2 reached, first runs after that.
    if (error instanceof MeasureError) error.files = [...files, ...first.slice(files.length)]
    throw error
  }
}

export interface MeasureTargetOptions {
  readonly id: string
  /** The target's default pin when absent. */
  readonly pin?: string
  readonly targetsDir: string
  readonly repositoryRoot: string
  /** The registry the image is built through: the controller's own `ensure` (plan D2). */
  readonly registry: ImageRegistry
  /** Where captures and session state are staged: `FACTORY_STATE_DIR`, never the app root. */
  readonly stagingRoot: string
  readonly signal: AbortSignal
  readonly fileTimeoutMs: number
  readonly memoryMb: number
  /** The target's own `resources.cpus` when absent. */
  readonly cpus?: number
  readonly runs: number
  /** Propose resources below the target's own (plan D12). */
  readonly allowDecrease: boolean
  readonly log?: (line: string) => void
  readonly now?: () => number
  /** Test seam: the sessions a measurement runs in. `dockerSessions` otherwise. */
  readonly sessions?: (recipe: TargetRecipe, imageId: string) => OpenSession
}

export type MeasureOutcome =
  | {
      readonly kind: "measured"
      readonly pin: string
      readonly image: EnsuredImage
      readonly measurement: Measurement
      readonly report: string
      /** `target.json` with the measured test command and resources, and `measurement.md`. */
      readonly files: readonly FileProposal[]
    }
  | {
      readonly kind: "promotion"
      readonly pin: string
      readonly promoted: readonly string[]
      readonly log: string
      /** The `Dockerfile` declaring the set the build promoted (plan D7). */
      readonly files: readonly FileProposal[]
    }

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((name, i) => name === [...b].sort()[i])

/**
 * Measure target `id` as it is on disk (so an uncommitted `target:init` output can be measured
 * before it is reviewed, placeholder resources and all: it is loaded with `loadTargetRecipe`,
 * never through the unmeasured-target refusal): build its image through the registry, then
 * `measureSuite`. A build that failed at the promotion check proposes the Dockerfile's set
 * instead, and stops. A `MeasureError` after the per-file phase leaves a partial report on the
 * error (`report`).
 */
export async function measureTarget(options: MeasureTargetOptions): Promise<MeasureOutcome> {
  const log = options.log ?? (() => {})
  const recipe = loadTargetRecipe(options.id, {
    targetsDir: options.targetsDir,
    repositoryRoot: options.repositoryRoot,
    ...(options.pin !== undefined ? { pin: options.pin } : {}),
  })
  const manifestPath = join(recipe.directory, "target.json")
  const before = readFileSync(manifestPath, "utf8")
  const current = TargetSchema.parse(JSON.parse(before))
  const notes: string[] = []
  if (recipe.pin !== current.pin) {
    const note = `Measured at ${recipe.pin}, not the target's default pin ${current.pin}; the proposal keeps the default pin.`
    notes.push(note)
    log(note)
  }
  let image: EnsuredImage
  try {
    image = await options.registry.ensure(recipe, {
      signal: options.signal,
      onBuild: () => log(`building ${recipe.id} at ${recipe.pin}`),
    })
  } catch (error) {
    if (!(error instanceof ImagePrepareError)) throw error
    const promoted = promotionMismatch(error.log)
    if (promoted === undefined) throw error
    const path = join(recipe.directory, "Dockerfile")
    const dockerfile = readFileSync(path, "utf8")
    // A set the Dockerfile already declares is not what failed: proposing it changes nothing.
    const declared = expectedPromotedOf(dockerfile)
    if (declared !== undefined && sameSet(declared, promoted)) throw error
    return {
      kind: "promotion",
      pin: recipe.pin,
      promoted,
      log: error.log,
      files: [{ path, before: dockerfile, after: withExpectedPromoted(dockerfile, promoted) }],
    }
  }
  // The workspace is the capture of `root` at the pin: a workspace path is root-relative.
  const tree = gitPinTree(options.repositoryRoot, recipe.pin)
  const existsAtPin = (path: string) =>
    tree.kind(recipe.root === "." ? path : `${recipe.root}/${path}`) !== undefined
  const sessions =
    options.sessions ??
    ((r: TargetRecipe, imageId: string) =>
      dockerSessions({
        recipe: r,
        imageId,
        stagingRoot: options.stagingRoot,
        repositoryRoot: options.repositoryRoot,
        signal: options.signal,
      }))
  let measurement: Measurement
  try {
    measurement = await measureSuite({
      recipe,
      open: sessions(recipe, image.image.localId),
      fileTimeoutMs: options.fileTimeoutMs,
      memoryMb: options.memoryMb,
      cpus: options.cpus ?? recipe.resources.cpus,
      runs: options.runs,
      allowDecrease: options.allowDecrease,
      ...(isPlaceholderResources(current.resources) ? {} : { prior: current.resources }),
      existsAtPin,
      log,
      ...(options.now !== undefined ? { now: options.now } : {}),
    })
  } catch (error) {
    if (error instanceof MeasureError && error.files !== undefined)
      error.report = [
        `# target:measure ${recipe.id} at ${recipe.pin}: stopped`,
        "",
        // The message may quote a listed name or a path: one line, sanitised.
        `> ${sanitize(error.message).replaceAll("\n", " ")}`,
        "",
        ...notes.flatMap((note) => [`> ${note}`, ""]),
        ...renderFiles(error.files),
      ].join("\n")
    throw error
  }
  const proposed = TargetSchema.parse({
    ...current,
    commands: { ...current.commands, test: [...measurement.test] },
    resources: measurement.resources,
  })
  const recordPath = join(recipe.directory, "measurement.md")
  return {
    kind: "measured",
    pin: recipe.pin,
    image,
    measurement,
    report: renderReport({
      target: recipe,
      image: { localId: image.image.localId, tag: image.tag },
      measurement,
      limits: options,
      notes,
    }),
    files: [
      {
        path: manifestPath,
        before,
        after: formatManifest(`${JSON.stringify(proposed, null, 2)}\n`),
      },
      {
        path: recordPath,
        before: readIfPresent(recordPath),
        after: renderMeasurementRecord(recipe.id, measurement.files),
      },
    ],
  }
}

export interface MeasureArgs {
  readonly id: string
  readonly pin?: string
  /** The target catalog to measure in; the controller's `targets/` when absent. */
  readonly targetsDir?: string
  readonly write: boolean
  readonly allowDecrease: boolean
  readonly runs: number
  readonly fileTimeoutMs: number
  readonly memoryMb: number
  readonly cpus?: number
}

export function parseMeasureArgs(argv: readonly string[]): MeasureArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      pin: { type: "string" },
      "targets-dir": { type: "string" },
      write: { type: "boolean", default: false },
      "allow-decrease": { type: "boolean", default: false },
      runs: { type: "string" },
      "file-timeout-ms": { type: "string" },
      "memory-mb": { type: "string" },
      cpus: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  })
  const [id, ...extra] = positionals
  if (!id || extra.length > 0)
    throw new Error(
      "usage: target-measure.ts <target-id> [--pin <sha>] [--targets-dir <dir>] [--write] [--allow-decrease] [--runs <n>] [--file-timeout-ms <ms>] [--memory-mb <mb>] [--cpus <n>]",
    )
  if (values.pin !== undefined && !commitSha.safeParse(values.pin).success)
    throw new Error(`--pin must be a full lowercase commit sha, got ${JSON.stringify(values.pin)}`)
  const integer = (name: string, value: string | undefined, fallback: number): number => {
    if (value === undefined) return fallback
    const n = Number(value)
    if (value.trim() === "" || !Number.isInteger(n) || n <= 0)
      throw new Error(`--${name} must be a positive integer, got ${JSON.stringify(value)}`)
    return n
  }
  let cpus: number | undefined
  if (values.cpus !== undefined) {
    cpus = Number(values.cpus)
    if (values.cpus.trim() === "" || !Number.isFinite(cpus) || cpus <= 0)
      throw new Error(`--cpus must be a positive number, got ${JSON.stringify(values.cpus)}`)
  }
  return {
    id,
    write: values.write,
    allowDecrease: values["allow-decrease"],
    runs: integer("runs", values.runs, 3),
    fileTimeoutMs: integer("file-timeout-ms", values["file-timeout-ms"], 180_000),
    memoryMb: integer("memory-mb", values["memory-mb"], 4096),
    ...(values.pin !== undefined ? { pin: values.pin } : {}),
    ...(values["targets-dir"] !== undefined ? { targetsDir: values["targets-dir"] } : {}),
    ...(cpus !== undefined ? { cpus } : {}),
  }
}
