import { execFileSync } from "node:child_process"
import cluster from "node:cluster"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { isMainThread } from "node:worker_threads"

export interface OwnerIdentity {
  readonly pid: number
  readonly start: string
  readonly boot: string
  readonly nonce: string
}
export interface OwnerLock {
  readonly identity: OwnerIdentity
  assertHeld(): void
  close(): void
}
export function assertSingleProcess(options: {
  readonly replicas?: number
  readonly workers?: number
}): void {
  const declarations = [
    options.replicas ?? 1,
    options.workers ?? 1,
    Number(process.env.WEB_CONCURRENCY ?? 1),
    Number(process.env.B4_RUNTIME_REPLICAS ?? 1),
  ]
  if (
    cluster.isWorker ||
    !isMainThread ||
    process.env.NODE_APP_INSTANCE !== undefined ||
    declarations.some((n) => n !== 1)
  )
    throw new Error(
      "SQLite runtime requires one execution owner; replicas and cluster workers require shared persistence",
    )
}
function identity(): OwnerIdentity {
  // Unlike kill(pid,0), the kernel lock plus this start/boot identity cannot
  // mistake a reused PID for its previous owner. No lock file is unlinked.
  let start: string
  let boot: string
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8")
    start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? ""
    boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  } else if (process.platform === "darwin") {
    start = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim()
    boot = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).trim()
  } else if (process.platform === "win32") {
    const powershell = join(
      process.env.SystemRoot ?? "C:Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    )
    const output = execFileSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${process.pid}; $os=Get-CimInstance Win32_OperatingSystem; @{start=$p.StartTime.ToUniversalTime().ToString('o');boot=$os.LastBootUpTime.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress`,
      ],
      { encoding: "utf8", windowsHide: true },
    )
    const data = JSON.parse(output) as { start: string; boot: string }
    start = data.start
    boot = data.boot
  } else throw new Error("Cannot verify SQLite runtime process identity on this platform")
  if (!start || !boot) throw new Error("Cannot verify SQLite runtime process identity")
  return { pid: process.pid, start, boot: `${hostname()}:${boot}`, nonce: randomUUID() }
}
export function acquireOwner(path: string): OwnerLock {
  const owner = identity()
  const db = new DatabaseSync(path)
  let closed = false
  try {
    // This auxiliary database holds only the kernel lifetime lock; process
    // identity and all application state are committed in runtime.sqlite. Keep
    // its empty-file initialization journal in memory so a normal owner crash
    // cannot leave a disk rollback journal requiring source-path recovery.
    db.exec(
      "PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE",
    )
  } catch (cause) {
    db.close()
    throw new Error("SQLite runtime already has an execution owner", { cause })
  }
  return {
    identity: owner,
    assertHeld() {
      if (closed || !db.isTransaction || owner.pid !== process.pid)
        throw new Error("SQLite runtime owner is closed or process identity changed")
    },
    close() {
      if (closed) return
      closed = true
      try {
        if (db.isTransaction) db.exec("ROLLBACK")
      } finally {
        db.close()
      }
    },
  }
}
