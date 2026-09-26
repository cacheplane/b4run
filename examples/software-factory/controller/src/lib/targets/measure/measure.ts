import type { TargetRecipe } from "../catalog.js"
import { listArgv, parseVitestCommand, perFileArgv, withExcludes } from "../vitest-command.js"
import {
  changedPaths,
  classifyFile,
  EXCLUDED,
  type FileMeasurement,
  MeasureError,
  type Measurement,
  proposeResources,
  type Resources,
  type SuiteSample,
  settleFile,
  settleResources,
} from "./classify.js"
import {
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
  for (const file of files)
    if (
      file === "" ||
      file.startsWith("/") ||
      file.startsWith("-") ||
      file.split("/").includes("..")
    )
      throw new MeasureError(
        `vitest listed ${JSON.stringify(file)}; a measured file is a path relative to the command directory`,
      )
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

async function buildOrThrow(session: MeasureSession) {
  const build = await session.build()
  if (!build.ok)
    throw new MeasureError(
      "The target's build fails in its own image: a defect of the target (its Dockerfile, capture or build command) to fix before anything is measured, not a test to exclude",
      build.output,
    )
  return build
}

/** One file alone in `session`, snapshotted before and after with the verifier's options. */
async function measureFile(
  session: MeasureSession,
  file: string,
  argv: readonly string[],
  options: MeasureSuiteOptions,
): Promise<FileMeasurement> {
  const before = await session.snapshot()
  const run = await session.vitest(argv)
  const after = await session.snapshot()
  return classifyFile(file, run, changedPaths(before, after), options, options.existsAtPin)
}

/** The whole `test` in a fresh session at `limits`: a sample, or a stop with the suite's output. */
async function sampleSuite(
  open: OpenSession,
  limits: SessionLimits,
  test: readonly string[],
  now: () => number,
  what: string,
): Promise<SuiteSample> {
  const started = now()
  const sample = await open(limits, async (session) => {
    const build = await buildOrThrow(session)
    const before = await session.snapshot()
    const suite = await session.vitest(test)
    const changed = changedPaths(before, await session.snapshot())
    const failure = suite.timedOut
      ? `did not finish within ${limits.commandTimeoutMs} ms`
      : suite.exitCode !== 0
        ? `failed (exit ${suite.exitCode})`
        : changed.length > 0
          ? `changed the workspace (${changed.slice(0, 10).join(", ")})`
          : undefined
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

  // Phase 1: each file alone. A file that changed the workspace, hung or was killed leaves
  // the container dirty or busy, so the next file gets a fresh one.
  const queue: { files: string[] | null } = { files: null }
  const first: FileMeasurement[] = []
  while (queue.files === null || queue.files.length > 0) {
    await open(limits, async (session) => {
      await buildOrThrow(session)
      if (queue.files === null) {
        const listed = listedFiles(await session.listFiles(listArgv(command)))
        if (listed.length === 0)
          throw new MeasureError(
            `vitest lists no test file for ${recipe.id}'s command (with --passWithNoTests an empty listing still exits 0): there is nothing to measure`,
          )
        log(`${listed.length} test files`)
        queue.files = listed
      }
      const pending = queue.files
      for (let file = pending.shift(); file !== undefined; file = pending.shift()) {
        const result = await measureFile(session, file, perFileArgv(command, file), options)
        first.push(result)
        log(`${result.verdict.padEnd(6)} ${file} (${result.ms} ms)`)
        if (result.changed.length > 0 || result.verdict === "hang" || result.verdict === "killed")
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
        return await measureFile(session, result.file, perFileArgv(command, result.file), options)
      })
      const settled = settleFile(result, again)
      files.push(settled)
      log(`${settled.verdict.padEnd(6)} ${result.file} (second run: ${again.verdict})`)
    }

    const excludes = files
      .filter((m) => EXCLUDED.has(m.verdict))
      .map((m) => m.file)
      .sort()
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
    const resources = settleResources(measured, options.prior, options.allowDecrease)

    // Phase 4: the proposal, tried. A verification session must also fit twice in the deadline.
    const confirmation = await sampleSuite(
      open,
      {
        memoryMb: resources.memoryMb,
        cpus: resources.cpus,
        commandTimeoutMs: resources.commandTimeoutMs,
      },
      test,
      now,
      `at the proposed resources ${JSON.stringify(resources)}: the proposed resources did not hold`,
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
