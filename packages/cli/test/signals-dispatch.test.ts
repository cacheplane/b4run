import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { run } from "../src/index.ts"
import type { SignalsEmitter } from "../src/lib/signals/emitter.ts"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { force: true, recursive: true })))
})
function fakeEmitter() {
  const calls: unknown[][] = []
  const emitter: SignalsEmitter = {
    commandStarted: (c) => {
      calls.push(["started", c])
    },
    commandCompleted: (i) => {
      calls.push([
        "completed",
        i.outcome,
        i.error === undefined ? undefined : (i.error as Error).name,
      ])
    },
    devFirstRunCompleted: (k) => {
      calls.push(["first-run", k])
    },
    flush: vi.fn(async () => {
      calls.push(["flush"])
    }),
  }
  return { emitter, calls }
}
const io = () => ({ stdout: () => undefined, stderr: () => undefined })
async function app(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "b4-signals-dispatch-"))
  dirs.push(root)
  for (const [p, s] of Object.entries({
    "package.json": '{"type":"module"}\n',
    "b4.config.ts": "export default {};\n",
    ...files,
  })) {
    await mkdir(join(root, p, ".."), { recursive: true })
    await writeFile(join(root, p), s)
  }
  return root
}

describe("run() reports through the emitter", () => {
  it("starts and completes an allowlisted command with outcome ok", async () => {
    const root = await app({
      "src/app/hello/index.ts": "export const graph = async () => ({ ok: true });\n",
    })
    const { emitter, calls } = fakeEmitter()
    const code = await run(["check", "--cwd", root], io(), { signals: emitter })
    expect(code).toBe(0)
    expect(calls).toEqual([["started", "check"], ["completed", "ok", undefined], ["flush"]])
  })
  it("reports error with the error and keeps the exit code", async () => {
    const root = await app({ "package.json": "{}\n" })
    const { emitter, calls } = fakeEmitter()
    const code = await run(["check", "--cwd", root], io(), { signals: emitter })
    expect(code).not.toBe(0)
    expect(calls[0]).toEqual(["started", "check"])
    expect(calls[1]?.[0]).toBe("completed")
    expect(calls[1]?.[1]).toBe("error")
    expect(calls[1]?.[2]).toBe("CliError")
    expect(calls.at(-1)).toEqual(["flush"])
  })
  it("emits nothing for --help, an unknown option, or an unknown command", async () => {
    for (const argv of [
      ["build", "--help"],
      ["start", "--help"],
      ["build", "--no-such-flag"],
      ["frobnicate"],
    ]) {
      const { emitter, calls } = fakeEmitter()
      await run(argv, io(), { signals: emitter })
      expect(
        calls.filter(([k]) => k === "completed"),
        argv.join(" "),
      ).toEqual([])
      expect(calls.at(-1), argv.join(" ")).toEqual(["flush"])
    }
  })
  it("still returns the command's exit code when flush rejects", async () => {
    const root = await app({
      "src/app/hello/index.ts": "export const graph = async () => ({ ok: true });\n",
    })
    const { emitter } = fakeEmitter()
    const broken: SignalsEmitter = {
      ...emitter,
      flush: async () => {
        throw new Error("transport")
      },
    }
    await expect(run(["check", "--cwd", root], io(), { signals: broken })).resolves.toBe(0)
  })
})

describe("the default emitter under the test environment", () => {
  it("is disabled by vitest.config.ts so the suite never reports", () => {
    expect(process.env.B4_TELEMETRY_DISABLED).toBe("1")
  })
})
