import { randomUUID } from "node:crypto"
import type { SandboxHandle } from "@b4run/workspace"
import { z } from "zod"
import type { Verdict } from "../domain/work-order.js"
import type { Suite, Target } from "../targets/catalog.js"

export interface SuiteEvent {
  readonly type: string
  readonly name: string
}

export interface SuiteResult {
  readonly verdict: Verdict
  readonly output: string
  readonly events: readonly SuiteEvent[]
}

/** One raw `node:test` (or flattened vitest) event, before it is trimmed to {@link SuiteEvent}. */
export interface RawEvent {
  readonly type: string
  readonly name: string
  readonly skip: boolean
  readonly todo: boolean
}

/**
 * Quote `argv` for a POSIX shell: every argument single-quoted, with an embedded `'`
 * escaped as `'\''`. A manifest's `commands.build`/`commands.test` entries are data, not
 * trusted shell fragments, so this is the one place they are allowed to become a shell
 * command line.
 */
export function shellJoin(argv: readonly string[]): string {
  return argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ")
}

/**
 * Grade a `node:test` run: pass requires every expected assertion to appear exactly once as
 * a passing event, with no skips, no todos and no extras. Anything the harness could not
 * determine is `inconclusive`, never `pass`: a suite that did not run is not a suite that
 * succeeded.
 */
export function gradeNodeTestEvents(
  exitCode: number,
  events: readonly RawEvent[],
  expected: readonly string[],
): { readonly verdict: Verdict; readonly events: readonly SuiteEvent[] } {
  const passed =
    exitCode === 0 &&
    expected.length > 0 &&
    events.length === expected.length &&
    events.every((event) => event.type === "test:pass" && !event.skip && !event.todo) &&
    expected.every((name) => events.filter((event) => event.name === name).length === 1)

  const sawFailure = events.some((event) => event.type === "test:fail")
  return {
    verdict: passed ? "pass" : sawFailure ? "fail" : "inconclusive",
    events: events.map((event) => ({ type: event.type, name: event.name })),
  }
}

const VitestAssertionResultSchema = z.object({
  fullName: z.string(),
  status: z.string(),
  failureMessages: z.array(z.string()).optional(),
})

const VitestTestResultSchema = z.object({
  assertionResults: z.array(VitestAssertionResultSchema).optional(),
})

/**
 * The shape trusted out of a vitest JSON reporter file. `.passthrough()` because vitest's
 * report carries many more fields than the ones graded here, and validation must not start
 * rejecting a real report the moment vitest adds one.
 */
const VitestJsonReportSchema = z
  .object({
    numFailedTests: z.number().optional(),
    numTotalTests: z.number().optional(),
    testResults: z.array(VitestTestResultSchema),
  })
  .passthrough()

export interface VitestGrade {
  readonly verdict: Verdict
  readonly events: readonly SuiteEvent[]
  /** Every failed assertion's own rendering, flattened, in report order. */
  readonly failureMessages: readonly string[]
}

/**
 * Grade a vitest JSON reporter report as pure data. Symmetric with
 * {@link gradeNodeTestEvents}: pass requires every expected assertion to appear exactly once
 * as a passing event, nothing else failed, the exit code agrees, and the report's own totals
 * (`numFailedTests`, `numTotalTests`) are present and consistent with that. A report vitest
 * could not produce, one that fails shape validation (parses as JSON but is not a report —
 * `null`, an array, a report whose `testResults` is not an array, and so on), or one that
 * disagrees with the exit code in a way that only a broken runner would produce, is
 * `inconclusive`, never a thrown exception: this function is fed untrusted process output and
 * must have an answer for anything that output could be.
 */
export function gradeVitestReport(
  exitCode: number,
  reportJson: string,
  expected: readonly string[],
): VitestGrade {
  let raw: unknown
  try {
    raw = JSON.parse(reportJson)
  } catch {
    return { verdict: "inconclusive", events: [], failureMessages: [] }
  }

  const validated = VitestJsonReportSchema.safeParse(raw)
  if (!validated.success) return { verdict: "inconclusive", events: [], failureMessages: [] }
  const parsed = validated.data

  const events: SuiteEvent[] = []
  const failureMessages: string[] = []
  for (const testResult of parsed.testResults)
    for (const assertion of testResult.assertionResults ?? []) {
      const type =
        assertion.status === "passed"
          ? "test:pass"
          : assertion.status === "failed"
            ? "test:fail"
            : `test:${assertion.status}`
      events.push({ type, name: assertion.fullName })
      if (assertion.status === "failed") failureMessages.push(...(assertion.failureMessages ?? []))
    }

  const failedCount = parsed.numFailedTests
  const sawFailure =
    (typeof failedCount === "number" && failedCount > 0) ||
    events.some((event) => event.type === "test:fail")

  if (sawFailure && exitCode !== 0) return { verdict: "fail", events, failureMessages }
  if (sawFailure) return { verdict: "inconclusive", events, failureMessages }

  const totalCount = parsed.numTotalTests
  const passed =
    exitCode === 0 &&
    typeof failedCount === "number" &&
    failedCount === 0 &&
    expected.length > 0 &&
    typeof totalCount === "number" &&
    totalCount >= expected.length &&
    expected.every(
      (name) =>
        events.filter((event) => event.type === "test:pass" && event.name === name).length === 1,
    )

  return { verdict: passed ? "pass" : "inconclusive", events, failureMessages }
}

type NodeTestSuite = Extract<Suite, { runner: "node-test" }>
type VitestSuite = Extract<Suite, { runner: "vitest" }>

/** `cd` into the target's command working directory unless it is already the workspace root. */
function cdPrefix(target: Pick<Target, "commands">): string {
  return target.commands.cwd === "." ? "" : `${shellJoin(["cd", target.commands.cwd])} && `
}

async function runAt(
  handle: SandboxHandle,
  target: Pick<Target, "commands">,
  argv: readonly string[],
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return handle.exec.runCommand(
    { command: `${cdPrefix(target)}${shellJoin(argv)}` },
    { workspaceRoot: handle.workspaceRoot, signal },
  )
}

/** Run the target's build step, if it has one. An empty argv means the target has none. */
export async function runBuild(
  handle: SandboxHandle,
  target: Pick<Target, "commands">,
  signal: AbortSignal,
): Promise<{ readonly ok: boolean; readonly output: string }> {
  if (target.commands.build.length === 0) return { ok: true, output: "(no build step)\n" }
  const result = await runAt(handle, target, target.commands.build, signal)
  return { ok: result.exitCode === 0, output: `${result.stdout}\n${result.stderr}` }
}

/**
 * Run a `node-test` suite inside the sandbox, using the target's own `execArgv` rather than
 * a hard-coded `--import tsx`, and grade it against its named assertions.
 *
 * The parent runner uses built-ins only. Submitted code runs in a child process, so its
 * stdout arrives as a `test:stdout` event and cannot forge a `test:pass` receipt.
 */
export async function runNodeTestSuite(
  handle: SandboxHandle,
  target: Pick<Target, "commands">,
  suite: NodeTestSuite,
  signal: AbortSignal,
): Promise<SuiteResult> {
  const program = `
const { run } = require('node:test')
;(async () => {
  const events = []
  let output = ''
  for await (const event of run({ files: [${JSON.stringify(suite.file)}], execArgv: ${JSON.stringify([...target.commands.nodeTestExecArgv])}, concurrency: 1 })) {
    if (event.type === 'test:pass' || event.type === 'test:fail')
      events.push({ type: event.type, name: event.data.name, skip: !!event.data.skip, todo: !!event.data.todo })
    if (event.type === 'test:stdout' || event.type === 'test:stderr') output += event.data.message
  }
  process.stdout.write(JSON.stringify({ events, output }))
})().catch((error) => { console.error(error); process.exitCode = 1 })
`
  let result: { stdout: string; stderr: string; exitCode: number }
  try {
    result = await handle.exec.runCommand(
      {
        command: `${cdPrefix(target)}/usr/local/bin/node <<'B4_SUITE_PROGRAM'\n${program}\nB4_SUITE_PROGRAM`,
      },
      { workspaceRoot: handle.workspaceRoot, signal },
    )
  } catch (error) {
    // A command that could not be run at all — a killed container, a per-command
    // timeout — says nothing about the candidate. Cancellation is the caller's
    // business, so it is re-thrown rather than dressed up as a verdict.
    if (signal.aborted) throw error
    return { verdict: "inconclusive", output: `suite did not run: ${String(error)}`, events: [] }
  }

  let parsed: { events: RawEvent[]; output: string }
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    // The runner itself did not report. We do not know whether the code is
    // correct, so we must not say it is, and we must not say it is broken.
    return { verdict: "inconclusive", output: `${result.stdout}\n${result.stderr}`, events: [] }
  }

  const graded = gradeNodeTestEvents(result.exitCode, parsed.events, suite.assertions)
  return { verdict: graded.verdict, output: parsed.output, events: graded.events }
}

/**
 * Run a vitest suite inside the sandbox with a JSON reporter appended to the target's own
 * test invocation, and grade the report as pure data.
 *
 * The report path and the marker that separates it from the run's own stdout both carry a
 * per-run nonce, so a suite cannot pre-write a forged report at a path or under a marker it
 * could guess before the run starts.
 *
 * That is a defense against a blind guess only. The nonce is not a secret from code running
 * inside the same container: it is plainly visible in the vitest process's own argv (in
 * `/proc/<pid>/cmdline` or `ps`) for any process able to read it, so a suite that spawns a
 * background writer to watch for and overwrite the report file after reading the nonce off
 * the command line could still forge it. Closing that requires running the target's tests as
 * a uid that cannot reach the report file at all (or the container's `/tmp`), which this
 * runner does not yet do — tracked as a follow-up, not fixed here.
 */
export async function runVitestSuite(
  handle: SandboxHandle,
  target: Pick<Target, "commands">,
  suite: VitestSuite,
  signal: AbortSignal,
): Promise<SuiteResult> {
  const nonce = randomUUID()
  const reportPath = `/tmp/b4-factory-vitest-report.${nonce}.json`
  const marker = `B4_FACTORY_REPORT_${nonce}`
  const argv = [
    ...target.commands.test,
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ]
  const command = [
    `rm -f ${reportPath}`,
    `${cdPrefix(target)}${shellJoin(argv)}`,
    "code=$?",
    "echo",
    `echo ${marker}`,
    `cat ${reportPath} 2>/dev/null`,
    "exit $code",
  ].join("; ")

  let result: { stdout: string; stderr: string; exitCode: number }
  try {
    result = await handle.exec.runCommand(
      { command },
      { workspaceRoot: handle.workspaceRoot, signal },
    )
  } catch (error) {
    if (signal.aborted) throw error
    return { verdict: "inconclusive", output: `suite did not run: ${String(error)}`, events: [] }
  }

  const markerLine = `${marker}\n`
  const markerIndex = result.stdout.lastIndexOf(markerLine)
  const output = markerIndex === -1 ? result.stdout : result.stdout.slice(0, markerIndex)
  const reportJson = markerIndex === -1 ? "" : result.stdout.slice(markerIndex + markerLine.length)

  const graded = gradeVitestReport(result.exitCode, reportJson, suite.assertions)
  const base = `${output}\n${result.stderr}`
  const finalOutput =
    graded.failureMessages.length === 0 ? base : `${base}\n${graded.failureMessages.join("\n")}`
  return { verdict: graded.verdict, output: finalOutput, events: graded.events }
}

/**
 * Run one suite inside the sandbox and grade it, dispatching on the suite's declared runner.
 */
export async function runSuite(
  handle: SandboxHandle,
  target: Pick<Target, "commands">,
  suite: Suite,
  signal: AbortSignal,
): Promise<SuiteResult> {
  return suite.runner === "node-test"
    ? runNodeTestSuite(handle, target, suite, signal)
    : runVitestSuite(handle, target, suite, signal)
}

/**
 * Bridge until Task 8: the rung 1 verifier (`docker-verifier.ts`) still loads a fixture whose
 * checks are the rung 1 `Suite` shape (`{file, assertions}`, no `runner`, always `node-test`,
 * always `--import tsx`). Kept as the rung 1 body, verbatim, so the verifier keeps compiling
 * without adopting a `Target` it does not have.
 */
export async function runFixtureSuite(
  handle: SandboxHandle,
  suite: { readonly file: string; readonly assertions: readonly string[] },
  signal: AbortSignal,
): Promise<SuiteResult> {
  const program = `
const { run } = require('node:test')
;(async () => {
  const events = []
  let output = ''
  for await (const event of run({ files: [${JSON.stringify(suite.file)}], execArgv: ['--import', 'tsx'], concurrency: 1 })) {
    if (event.type === 'test:pass' || event.type === 'test:fail')
      events.push({ type: event.type, name: event.data.name, skip: !!event.data.skip, todo: !!event.data.todo })
    if (event.type === 'test:stdout' || event.type === 'test:stderr') output += event.data.message
  }
  process.stdout.write(JSON.stringify({ events, output }))
})().catch((error) => { console.error(error); process.exitCode = 1 })
`
  let result: { stdout: string; stderr: string; exitCode: number }
  try {
    result = await handle.exec.runCommand(
      {
        command: `/usr/local/bin/node --import tsx <<'B4_SUITE_PROGRAM'\n${program}\nB4_SUITE_PROGRAM`,
      },
      { workspaceRoot: handle.workspaceRoot, signal },
    )
  } catch (error) {
    if (signal.aborted) throw error
    return { verdict: "inconclusive", output: `suite did not run: ${String(error)}`, events: [] }
  }

  let parsed: { events: RawEvent[]; output: string }
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return { verdict: "inconclusive", output: `${result.stdout}\n${result.stderr}`, events: [] }
  }

  const graded = gradeNodeTestEvents(result.exitCode, parsed.events, suite.assertions)
  return { verdict: graded.verdict, output: parsed.output, events: graded.events }
}
