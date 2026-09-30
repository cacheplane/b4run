import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

const packageRoot = join(import.meta.dirname, "..")
const probe = join(import.meta.dirname, "fixtures/signal-probe.ts")
const factoryScript = (
  JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>
  }
).scripts.factory as string

let dir: string | undefined
let group: number | undefined
afterEach(() => {
  // Only on a failure: the probe exits by itself; its group is ours alone, killed by pgid.
  if (group !== undefined)
    try {
      process.kill(-group, "SIGKILL")
    } catch {
      // Already gone.
    }
  group = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

const events = (path: string) =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : []

describe("the factory script's launcher", () => {
  // One Ctrl-C under `pnpm factory up` reaches up three times within milliseconds: the
  // terminal's SIGINT to the whole group, the inner pnpm's relayed SIGINT, and the SIGTERM the
  // inner pnpm sends when the outer pnpm relays its SIGINT too (pnpm's second-SIGINT rule). A
  // launcher that relays signals itself (the tsx CLI) SIGKILLs a child that does not answer each
  // relay within about 30 ms, and up is busy for longer than that while it starts its ordered
  // stop: its detached workers were orphaned. up must be the process the script starts.
  it("lets a busy child that handles one Ctrl-C, relayed as pnpm relays it, exit by its own hand", async () => {
    // pnpm runs the script with `sh -c`. bash (macOS's sh) execs a lone command, so the
    // script's command is the process pnpm relays to and all three signals reach it. dash
    // (Debian's and Ubuntu's sh) forks it instead and dies of the terminal's SIGINT itself, so
    // pnpm's relays land on a dead sh and the command sees one SIGINT only. The test starts the
    // command as bash does, without a shell, so every platform drives the harder case: and a
    // shell exiting first can never end the wait before the stand-in has. That needs the script
    // to be plain words, which splitting on spaces then reads exactly as sh would.
    expect(factoryScript).toMatch(/^[\w@./=:+-]+( [\w@./=:+-]+)*$/)
    const argv = factoryScript.split(" ")
    expect(argv).toContain("src/cli.ts")
    dir = mkdtempSync(join(tmpdir(), "factory-launcher-"))
    const report = join(dir, "report")
    const [command, ...args] = argv.map((word) => (word === "src/cli.ts" ? probe : word))
    const child = spawn(command as string, args, {
      cwd: packageRoot,
      env: {
        ...process.env,
        // As pnpm runs a script: the package's own bins first.
        PATH: `${join(packageRoot, "node_modules/.bin")}${delimiter}${process.env.PATH ?? ""}`,
        SIGNAL_PROBE_REPORT: report,
      },
      // Its own process group, as a terminal's foreground group would be.
      detached: true,
      stdio: "ignore",
    })
    group = child.pid as number
    const exited = new Promise<{ code: number | null; signal: string | null }>((done) =>
      child.once("exit", (code, signal) => done({ code, signal })),
    )
    const deadline = Date.now() + 20_000
    while (!events(report).includes("ready")) {
      if (Date.now() > deadline) throw new Error("the probe never started")
      await new Promise((r) => setTimeout(r, 50))
    }
    process.kill(-group, "SIGINT")
    process.kill(child.pid as number, "SIGINT")
    process.kill(child.pid as number, "SIGTERM")
    const exit = await exited
    group = undefined
    expect(events(report).at(-1)).toBe("exit 0")
    expect(exit).toEqual({ code: 0, signal: null })
  }, 30_000)
})
