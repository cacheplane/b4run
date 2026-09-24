import { randomUUID } from "node:crypto"
import type { SandboxHandle } from "@b4run/workspace"
import { z } from "zod"
import type { Verdict } from "../domain/work-order.js"
import type { Suite, Target } from "../targets/catalog.js"

export interface SuiteEvent {
  readonly type: string
  readonly name: string
  /**
   * On a `test:fail`, what failed: the error's `code` or, without one, its name, read from
   * the failure's `cause` (`ERR_ASSERTION` for a failing `node:assert`, `TypeError` for a
   * throw, `ERR_MODULE_NOT_FOUND` for a missing import). Absent when the runner gave none,
   * which is what a file that fails to load reports: node:test names that failure after the
   * file itself, with no cause.
   */
  readonly failure?: string
  /**
   * On a `test:fail`, the first line of what the failure said, ANSI-stripped and bounded to
   * {@link FAILURE_MESSAGE_LIMIT} characters: the cause's own message for a test that failed,
   * and for a file that failed to load, the first error line the child wrote to stderr (the
   * runner's own message for that failure is only `test failed`). Absent when there was none.
   * A refusal quotes it so a redraft is told what actually happened, not just its code.
   */
  readonly message?: string
  /**
   * Present (and true) only for a `test.skip` / `test.todo` event. node:test reports a todo
   * test that fails as a `test:fail` that does not fail the run: it proves nothing.
   */
  readonly skip?: true
  readonly todo?: true
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
  /** See {@link SuiteEvent.failure}; null or absent when the runner gave none. */
  readonly failure?: string | null
  /** See {@link SuiteEvent.message}; raw, before {@link failureMessageLine} trims it. */
  readonly message?: string | null
}

/** The most of a failure's message a {@link SuiteEvent} keeps. */
export const FAILURE_MESSAGE_LIMIT = 300

// CSI and OSC escape sequences: colour codes a runner or a thrown message may carry.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point
const ANSI = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g

/**
 * The first non-empty line of a failure message, ANSI-stripped, whitespace-trimmed and
 * bounded to {@link FAILURE_MESSAGE_LIMIT} characters (an ellipsis marks a cut), or null when
 * nothing is left. One line because a refusal reason is one line.
 */
export function failureMessageLine(message: string | null | undefined): string | null {
  if (typeof message !== "string") return null
  const line = message
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0)
  if (line === undefined) return null
  return line.length > FAILURE_MESSAGE_LIMIT
    ? `${line.slice(0, FAILURE_MESSAGE_LIMIT - 1)}\u2026`
    : line
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
    events: events.map((event) => {
      const message = event.type === "test:fail" ? failureMessageLine(event.message) : null
      return {
        type: event.type,
        name: event.name,
        ...(typeof event.failure === "string" && event.failure.length > 0
          ? { failure: event.failure }
          : {}),
        ...(message !== null ? { message } : {}),
        ...(event.skip ? { skip: true as const } : {}),
        ...(event.todo ? { todo: true as const } : {}),
      }
    }),
  }
}

/** A failing `node:assert` assertion, as {@link SuiteEvent.failure} spells it. */
export const ASSERTION_FAILURE = "ERR_ASSERTION"

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
 * (`numFailedTests`, `numTotalTests`) are present and consistent with that. With no expected
 * names at all — a generated task's visible suite, where the target's whole suite is the
 * regression guard — pass requires the same clean exit and totals and that at least one test
 * passed: a suite the runner selected nothing from, or skipped entirely, proves nothing. A
 * report vitest
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
  const cleanRun =
    exitCode === 0 &&
    typeof failedCount === "number" &&
    failedCount === 0 &&
    typeof totalCount === "number"
  const passed =
    cleanRun &&
    (expected.length === 0
      ? totalCount > 0 && events.some((event) => event.type === "test:pass")
      : totalCount >= expected.length &&
        expected.every(
          (name) =>
            events.filter((event) => event.type === "test:pass" && event.name === name).length ===
            1,
        ))

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
 * Unlike the build and vitest commands, this one runs at the WORKSPACE ROOT and never `cd`s
 * into `commands.cwd`. Suite file paths in the catalog are workspace-root-relative: the
 * independent check is written to `checks/<name>` at the root by the verifier itself, and a
 * visible node-test file may live anywhere in the tree (`packages/x/test/y.test.ts`). A
 * check reaches the built artifact through the target's cwd in its own import specifier
 * (`packages/devkit/dist/...`), so the runner has no cwd to supply.
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
  let stderr = ''
  // A file that fails to load is reported as 'test failed' with no cause: what went wrong is
  // only in the child's stderr, so its first error line stands in for the message. One file
  // runs, so its stderr is all of it (the events name that file relative and absolute).
  const loadError = () => {
    const text = stderr.replace(/\\u001b\\[[0-9;?]*[ -\\/]*[@-~]/g, '')
    const line = text.split('\\n').find((l) => /^\\s*[A-Za-z]*(?:Error|Exception)\\b[^:\\n]*:\\s*\\S/.test(l))
    return line ?? null
  }
  for await (const event of run({ files: [${JSON.stringify(suite.file)}], execArgv: ${JSON.stringify([...target.commands.nodeTestExecArgv])}, concurrency: 1 })) {
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const error = event.type === 'test:fail' ? event.data.details?.error : undefined
      const cause = error?.cause
      const failure = cause && typeof cause === 'object' ? (typeof cause.code === 'string' ? cause.code : typeof cause.name === 'string' ? cause.name : null) : null
      const raw = cause && typeof cause === 'object' ? (typeof cause.message === 'string' ? cause.message : null) : event.type === 'test:fail' ? (loadError() ?? (typeof cause === 'string' && cause !== 'test failed' ? cause : null)) : null
      const message = typeof raw === 'string' ? raw.slice(0, 4096) : null
      events.push({ type: event.type, name: event.data.name, skip: !!event.data.skip, todo: !!event.data.todo, failure, message })
    }
    if (event.type === 'test:stdout' || event.type === 'test:stderr') output += event.data.message
    if (event.type === 'test:stderr' && stderr.length < 65536) stderr += event.data.message
  }
  process.stdout.write(JSON.stringify({ events, output }))
})().catch((error) => { console.error(error); process.exitCode = 1 })
`
  let result: { stdout: string; stderr: string; exitCode: number }
  try {
    result = await handle.exec.runCommand(
      {
        command: `/usr/local/bin/node <<'B4_SUITE_PROGRAM'\n${program}\nB4_SUITE_PROGRAM`,
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
