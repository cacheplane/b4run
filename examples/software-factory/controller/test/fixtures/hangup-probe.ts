// up's own signal handling in a real process: `stopOnSignals(process, …)`, and an exit 0 once
// `stop` fires. It appends each line up would print, and "exit 0", to HANGUP_PROBE_REPORT, so a
// test can tell a process that survived a SIGHUP from one node's default ended.
import { appendFileSync } from "node:fs"
import { stopOnSignals } from "../../src/lib/operator/up.ts"

const report = process.env.HANGUP_PROBE_REPORT as string
const say = (line: string) => appendFileSync(report, `${line}\n`)
const { stop } = stopOnSignals(process, say)
stop.addEventListener("abort", () => {
  say("exit 0")
  process.exit(0)
})
setInterval(() => undefined, 1_000)
say("ready")
