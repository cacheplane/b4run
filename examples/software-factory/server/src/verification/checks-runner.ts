import type { SandboxHandle } from "@b4run/workspace"
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

interface VitestAssertionResult {
  readonly fullName?: string
  readonly status?: string
}

interface VitestTestResult {
  readonly assertionResults?: readonly VitestAssertionResult[]
}

interface VitestJsonReport {
  readonly numFailedTests?: unknown
  readonly testResults?: readonly VitestTestResult[]
}

/**
 * Grade a vitest JSON reporter report as pure data. Symmetric with
 * {@link gradeNodeTestEvents}: pass requires every expected assertion to appear exactly once
 * as a passing event, nothing else failed, and the exit code agrees. A report vitest could
 * not produce, or that disagrees with the exit code in a way that only a broken runner would
 * produce, is `inconclusive`.
 */
export function gradeVitestReport(
  exitCode: number,
  reportJson: string,
  expected: readonly string[],
): SuiteResult {
  let parsed: VitestJsonReport
  try {
    parsed = JSON.parse(reportJson)
  } catch {
    return { verdict: "inconclusive", output: reportJson, events: [] }
  }

  const events: SuiteEvent[] = []
  for (const testResult of parsed.testResults ?? [])
    for (const assertion of testResult.assertionResults ?? []) {
      const name = assertion.fullName ?? ""
      const type =
        assertion.status === "passed"
          ? "test:pass"
          : assertion.status === "failed"
            ? "test:fail"
            : `test:${assertion.status ?? "unknown"}`
      events.push({ type, name })
    }

  const failedCount = typeof parsed.numFailedTests === "number" ? parsed.numFailedTests : Number.NaN
  const sawFailure = failedCount > 0 || events.some((event) => event.type === "test:fail")

  if (sawFailure && exitCode !== 0) return { verdict: "fail", output: reportJson, events }
  if (sawFailure) return { verdict: "inconclusive", output: reportJson, events }

  const passed =
    exitCode === 0 &&
    failedCount === 0 &&
    expected.length > 0 &&
    expected.every(
      (name) =>
        events.filter((event) => event.type === "test:pass" && event.name === name).length === 1,
    )

  return { verdict: passed ? "pass" : "inconclusive", output: reportJson, events }
}

type NodeTestSuite = Extract<Suite, { runner: "node-test" }>
type VitestSuite = Extract<Suite, { runner: "vitest" }>

/** `cd` into the target's command working directory unless it is already the workspace root. */
function cdPrefix(target: Pick<Target, "commands">): string {
  return target.commands.cwd === "." ? "" : `cd '${target.commands.cwd}' && `
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

/** Marks the last line of a vitest run's stdout, before the JSON report it wrote to disk. */
const REPORT_MARKER = "B4_FACTORY_REPORT"
const REPORT_PATH = "/tmp/b4-factory-vitest-report.json"

/**
 * Run a vitest suite inside the sandbox with a JSON reporter appended to the target's own
 * test invocation, and grade the report as pure data.
 */
export async function runVitestSuite(
  handle: SandboxHandle,
  target: Pick<Target, "commands">,
  suite: VitestSuite,
  signal: AbortSignal,
): Promise<SuiteResult> {
  const argv = [...target.commands.test, "--reporter=json", `--outputFile=${REPORT_PATH}`]
  const command = [
    `rm -f ${REPORT_PATH}`,
    `${cdPrefix(target)}${shellJoin(argv)}`,
    "code=$?",
    "echo",
    `echo ${REPORT_MARKER}`,
    `cat ${REPORT_PATH} 2>/dev/null`,
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

  const markerLine = `${REPORT_MARKER}\n`
  const markerIndex = result.stdout.lastIndexOf(markerLine)
  const output = markerIndex === -1 ? result.stdout : result.stdout.slice(0, markerIndex)
  const reportJson = markerIndex === -1 ? "" : result.stdout.slice(markerIndex + markerLine.length)

  const graded = gradeVitestReport(result.exitCode, reportJson, suite.assertions)
  return { verdict: graded.verdict, output: `${output}\n${result.stderr}`, events: graded.events }
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
