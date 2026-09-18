import type { SandboxHandle } from "@b4run/workspace"
import type { Verdict } from "../domain/work-order.js"
import type { Suite } from "../fixtures/catalog.js"

export interface SuiteEvent {
  readonly type: string
  readonly name: string
}

export interface SuiteResult {
  readonly verdict: Verdict
  readonly output: string
  readonly events: readonly SuiteEvent[]
}

interface RawEvent {
  readonly type: string
  readonly name: string
  readonly skip: boolean
  readonly todo: boolean
}

/**
 * Run one suite inside the sandbox and grade it against its named assertions.
 *
 * A pass requires every expected assertion to appear exactly once as a passing
 * event, with no skips and no extras. Anything the harness could not determine
 * is `inconclusive`, never `pass`: a suite that did not run is not a suite that
 * succeeded.
 *
 * The parent runner uses built-ins only. Submitted code runs in a child process,
 * so its stdout arrives as a `test:stdout` event and cannot forge a `test:pass`
 * receipt.
 */
export async function runSuite(
  handle: SandboxHandle,
  suite: Suite,
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
    return {
      verdict: "inconclusive",
      output: `${result.stdout}\n${result.stderr}`,
      events: [],
    }
  }

  const expected = suite.assertions
  const passed =
    result.exitCode === 0 &&
    expected.length > 0 &&
    parsed.events.length === expected.length &&
    parsed.events.every((event) => event.type === "test:pass" && !event.skip && !event.todo) &&
    expected.every((name) => parsed.events.filter((event) => event.name === name).length === 1)

  const sawFailure = parsed.events.some((event) => event.type === "test:fail")
  return {
    verdict: passed ? "pass" : sawFailure ? "fail" : "inconclusive",
    output: parsed.output,
    events: parsed.events.map((event) => ({ type: event.type, name: event.name })),
  }
}
