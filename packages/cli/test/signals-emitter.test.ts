import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { readCliVersion } from "../src/lib/signals/cli-version.ts"
import { createSignalsEmitter, FIRST_RUN_NOTICE } from "../src/lib/signals/emitter.ts"
import { DEFAULT_SIGNALS_URL, type FetchLike } from "../src/lib/signals/transport.ts"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { force: true, recursive: true })))
})
async function harness(env: Record<string, string> = {}, home?: string) {
  const homeDir = home ?? (await mkdtemp(join(tmpdir(), "b4-emitter-")))
  if (home === undefined) dirs.push(homeDir)
  const stderr: string[] = []
  const fetch = vi.fn<FetchLike>(async () => ({ ok: true, status: 202 }))
  const emitter = createSignalsEmitter({
    io: { stdout: () => undefined, stderr: (m) => stderr.push(m) },
    env,
    homeDir,
    fetch,
    cliVersion: "0.14.0",
    nodeMajor: 24,
    os: "linux",
    now: () => new Date("2026-10-21T12:00:00.000Z"),
  })
  const bodies = () =>
    fetch.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body))
  return { emitter, stderr, fetch, bodies, homeDir }
}

describe("createSignalsEmitter", () => {
  it("prints the notice exactly once, before the first send, and creates the id", async () => {
    const h = await harness()
    h.emitter.commandStarted("build")
    h.emitter.commandCompleted({ outcome: "ok", durationMs: 10 })
    await h.emitter.flush()
    expect(h.stderr.join("")).toBe(FIRST_RUN_NOTICE)
    expect(FIRST_RUN_NOTICE).toBe(
      "B4.run collects anonymous usage signals (command, version, OS, outcome) to\n" +
        "improve the CLI. No code, paths, or identity are collected.\n" +
        "Disable: B4_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1. Details: https://b4.run/privacy\n",
    )
    const id = (await readFile(join(h.homeDir, ".b4", "usage-id"), "utf8")).trim()
    expect(h.bodies()).toEqual([
      {
        schema: 1,
        usage_id: id,
        sent_at: "2026-10-21T12:00:00.000Z",
        events: [
          {
            event: "cli:command_completed",
            properties: {
              command: "build",
              cli_version: "0.14.0",
              node_major: 24,
              os: "linux",
              outcome: "ok",
              duration_bucket: "under_1s",
            },
          },
        ],
      },
    ])
    const again = await harness({}, h.homeDir)
    again.emitter.commandStarted("check")
    again.emitter.commandCompleted({ outcome: "error", durationMs: 2000, error: new Error("x") })
    await again.emitter.flush()
    expect(again.stderr).toEqual([])
    expect(again.bodies()[0].events[0].properties).toMatchObject({
      outcome: "error",
      error_class: "Error",
      duration_bucket: "1s_to_10s",
    })
  })
  it("is inert for a non-reporting command: no file, no notice, no send", async () => {
    const h = await harness()
    h.emitter.commandStarted("start")
    h.emitter.commandCompleted({ outcome: "ok", durationMs: 1 })
    h.emitter.devFirstRunCompleted("agent")
    await h.emitter.flush()
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.stderr).toEqual([])
    await expect(readFile(join(h.homeDir, ".b4", "usage-id"))).rejects.toThrow()
  })
  it("is inert without a started command", async () => {
    const h = await harness()
    h.emitter.commandCompleted({ outcome: "ok", durationMs: 1 })
    await h.emitter.flush()
    expect(h.fetch).not.toHaveBeenCalled()
  })
  it.each([
    { B4_TELEMETRY_DISABLED: "1" },
    { DO_NOT_TRACK: "1" },
    { CI: "true" },
    { GITHUB_ACTIONS: "true" },
  ])("is inert before any file write or network call under %o", async (env) => {
    const h = await harness(env)
    h.emitter.commandStarted("dev")
    h.emitter.devFirstRunCompleted("graph")
    h.emitter.commandCompleted({ outcome: "ok", durationMs: 1 })
    await h.emitter.flush()
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.stderr).toEqual([])
    await expect(readFile(join(h.homeDir, ".b4", "usage-id"))).rejects.toThrow()
  })
  it("is inert without a usable home directory", async () => {
    const h = await harness({}, "")
    h.emitter.commandStarted("build")
    h.emitter.commandCompleted({ outcome: "ok", durationMs: 1 })
    await h.emitter.flush()
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.stderr).toEqual([])
  })
  it("sends cli:dev_first_run_completed at most once", async () => {
    const h = await harness()
    h.emitter.commandStarted("dev")
    h.emitter.devFirstRunCompleted("graph")
    h.emitter.devFirstRunCompleted("agent")
    await h.emitter.flush()
    const first = h.bodies().filter((b) => b.events[0].event === "cli:dev_first_run_completed")
    expect(first).toHaveLength(1)
    expect(first[0].events[0].properties).toEqual({ cli_version: "0.14.0", route_kind: "graph" })
  })
  it("uses B4_SIGNALS_URL", async () => {
    const h = await harness({ B4_SIGNALS_URL: "http://127.0.0.1:1/cli" })
    h.emitter.commandStarted("build")
    h.emitter.commandCompleted({ outcome: "ok", durationMs: 1 })
    await h.emitter.flush()
    expect(h.fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:1/cli")
  })
  it("reads B4_SIGNALS_URL from the creation-time env only, never from a later env", async () => {
    const home = await mkdtemp(join(tmpdir(), "b4-emitter-"))
    dirs.push(home)
    const fetch = vi.fn<FetchLike>(async () => ({ ok: true, status: 202 }))
    const startup: Record<string, string | undefined> = {}
    const later: Record<string, string | undefined> = {}
    const emitter = createSignalsEmitter({
      io: { stdout: () => undefined, stderr: () => undefined },
      env: startup,
      currentEnv: () => later,
      homeDir: home,
      fetch,
      cliVersion: "0.14.0",
      nodeMajor: 24,
      os: "linux",
    })
    emitter.commandStarted("dev")
    // A project .env loaded after startup must not move the endpoint.
    later.B4_SIGNALS_URL = "http://127.0.0.1:1/elsewhere"
    startup.B4_SIGNALS_URL = "http://127.0.0.1:1/elsewhere"
    emitter.commandCompleted({ outcome: "ok", durationMs: 1 })
    await emitter.flush()
    expect(fetch.mock.calls[0]?.[0]).toBe(DEFAULT_SIGNALS_URL)
  })
  it("sends nothing when the opt-out appears in the current env after commandStarted", async () => {
    const home = await mkdtemp(join(tmpdir(), "b4-emitter-"))
    dirs.push(home)
    const fetch = vi.fn<FetchLike>(async () => ({ ok: true, status: 202 }))
    const later: Record<string, string | undefined> = {}
    const emitter = createSignalsEmitter({
      io: { stdout: () => undefined, stderr: () => undefined },
      env: {},
      currentEnv: () => later,
      homeDir: home,
      fetch,
      cliVersion: "0.14.0",
      nodeMajor: 24,
      os: "linux",
    })
    emitter.commandStarted("dev")
    later.B4_TELEMETRY_DISABLED = "1"
    emitter.devFirstRunCompleted("graph")
    emitter.commandCompleted({ outcome: "ok", durationMs: 1 })
    await emitter.flush()
    expect(fetch).not.toHaveBeenCalled()
  })
  it("never throws or rejects when the transport fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "b4-emitter-"))
    dirs.push(home)
    const emitter = createSignalsEmitter({
      io: { stdout: () => undefined, stderr: () => undefined },
      env: {},
      homeDir: home,
      fetch: () => {
        throw new Error("down")
      },
      cliVersion: "0.14.0",
      nodeMajor: 24,
      os: "linux",
    })
    expect(() => {
      emitter.commandStarted("build")
      emitter.commandCompleted({ outcome: "ok", durationMs: 1 })
    }).not.toThrow()
    await expect(emitter.flush()).resolves.toBeUndefined()
  })
})

describe("readCliVersion", () => {
  it("reads the package version", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
    expect(readCliVersion()).toBe(pkg.version)
  })
})
