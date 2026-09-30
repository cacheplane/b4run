// A stand-in for `up` under the `factory` script's launcher: it handles SIGINT, SIGTERM and
// SIGHUP, and on the first one does what up's stop does first, synchronous work (the registry
// read, the log appends) that keeps its event loop busy, then exits 0 by its own hand a moment
// later. It appends each event to SIGNAL_PROBE_REPORT, so a test can tell "exited 0" from
// "killed by a layer above it".
import { appendFileSync } from "node:fs"

const report = process.env.SIGNAL_PROBE_REPORT as string
const say = (event: string) => appendFileSync(report, `${event}\n`)
let stopping = false
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(name, () => {
    say(name)
    if (stopping) return
    stopping = true
    const busyUntil = Date.now() + Number(process.env.SIGNAL_PROBE_BUSY_MS ?? 300)
    while (Date.now() < busyUntil) {
      // Busy, as up is while it reads the registry and writes its stop line.
    }
    setTimeout(() => {
      say("exit 0")
      process.exit(0)
    }, 1_000)
  })
setInterval(() => undefined, 1_000)
say("ready")
