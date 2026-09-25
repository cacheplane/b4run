import { describe, expect, test } from "vitest"
import type { Docker } from "../src/docker/docker-cli.ts"
import { dockerSandbox } from "../src/docker/docker-sandbox.ts"

const SCOPE = "sandbox-test"
const THREAD = "abc"
/** resourceScope("sandbox-test")("abc") — pinned by resource-scope.test.ts. */
const RESOURCE_ID = "2b15794eccdd038fd62a47fecd25562bace17167"
const KEEPER = `b4-sbx-${RESOURCE_ID}`
const VOLUME = `b4-sbx-vol-${RESOURCE_ID}`
const MOUNTPOINT = `/var/lib/docker/volumes/${VOLUME}/_data`

const signal = () => new AbortController().signal

interface Recorder {
  readonly docker: Docker
  readonly runs: string[][]
  readonly execs: { container: string; command: string[] }[]
}

function recordingDocker(
  overrides: {
    readonly volumeExitCode?: number
    readonly createExitCode?: number
    readonly createThrows?: Error
    readonly mountpoint?: string
    readonly removeExitCode?: number
    readonly removeStderr?: string
  } = {},
): Recorder {
  const runs: string[][] = []
  const execs: { container: string; command: string[] }[] = []
  const docker: Docker = {
    run: async (args) => {
      runs.push([...args])
      if (args[0] === "volume" && args[1] === "inspect") {
        return {
          stdout: overrides.mountpoint ?? MOUNTPOINT,
          stderr: "",
          exitCode: overrides.volumeExitCode ?? 0,
        }
      }
      if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0 }
      if (args[0] === "run") {
        if (overrides.createThrows) throw overrides.createThrows
        if (overrides.createExitCode !== undefined) {
          return { stdout: "", stderr: "no such image", exitCode: overrides.createExitCode }
        }
      }
      if (args[0] === "rm" && overrides.removeExitCode !== undefined) {
        return {
          stdout: "",
          stderr: overrides.removeStderr ?? "device or resource busy",
          exitCode: overrides.removeExitCode,
        }
      }
      return { stdout: "ok", stderr: "", exitCode: 0 }
    },
    exec: async (container, command) => {
      execs.push({ container, command: [...command] })
      return { stdout: "", stderr: "", exitCode: 0 }
    },
  }
  return { docker, runs, execs }
}

const readerRun = (runs: readonly string[][]) =>
  runs.find((r) => r[0] === "run" && r.join(" ").includes("b4-sbx-rdr-"))

describe("dockerSandbox.openWorkspaceReader (unit, no daemon)", () => {
  test("does not touch the thread's keeper container", async () => {
    const { docker, runs, execs } = recordingDocker()
    const p = dockerSandbox({ scope: SCOPE, image: "node:22-slim", docker })
    const reader = await p.openWorkspaceReader?.({ threadId: THREAD, signal: signal() })
    await reader?.filesystem.listDir("/workspace", {
      signal: signal(),
      workspaceRoot: "/workspace",
    })

    // The keeper's exact name must appear in no command at all: not a `ps`, not
    // an `inspect`, not a `start`, not an `rm`. This is the non-disturbance
    // proof that needs no daemon.
    for (const args of runs) expect(args).not.toContain(KEEPER)
    for (const { container } of execs) expect(container).not.toBe(KEEPER)
    expect(runs.map((args) => args[0])).toEqual(["volume", "run"])
  })

  test("mounts the thread volume read-only into a hardened, networkless container", async () => {
    const { docker, runs } = recordingDocker()
    const p = dockerSandbox({ scope: SCOPE, image: "node:22-slim", docker })
    await p.openWorkspaceReader?.({ threadId: THREAD, signal: signal() })
    const joined = (readerRun(runs) ?? []).join(" ")

    expect(joined).toContain(`--mount type=bind,source=${MOUNTPOINT},target=/workspace,readonly`)
    // A named-volume mount would CREATE the volume if it had just been
    // destroyed, resurrecting the thread's workspace as an empty one.
    expect(joined).not.toContain(`${VOLUME}:/workspace`)
    expect(readerRun(runs)).not.toContain("-v")
    expect(joined).toContain("--network none")
    expect(joined).toContain("--cap-drop ALL")
    expect(joined).toContain("--security-opt no-new-privileges")
    expect(joined).toContain("--pids-limit 128")
    expect(joined).toContain("--read-only")
    expect(joined).toContain("--tmpfs /tmp")
    expect(joined).toContain("--user 1000:1000")
    expect(joined).toContain(`--label b4.sandbox.reader=${RESOURCE_ID}`)
    expect(joined).toContain("--rm")
    expect(joined).toContain("sleep infinity")
  })

  test("names each reader container uniquely so concurrent reads do not collide", async () => {
    const { docker, runs } = recordingDocker()
    const p = dockerSandbox({ scope: SCOPE, image: "node:22-slim", docker })
    await p.openWorkspaceReader?.({ threadId: THREAD, signal: signal() })
    await p.openWorkspaceReader?.({ threadId: THREAD, signal: signal() })
    const names = runs
      .filter((r) => r[0] === "run")
      .map((r) => r[r.indexOf("--name") + 1] as string)
    expect(names).toHaveLength(2)
    expect(new Set(names).size).toBe(2)
    for (const name of names) expect(name.startsWith(`b4-sbx-rdr-${RESOURCE_ID}-`)).toBe(true)
  })

  test("runAsNonRoot false drops --user; an explicit uid/gid is honoured", async () => {
    const off = recordingDocker()
    const pOff = dockerSandbox({ scope: SCOPE, image: "node:22-slim", docker: off.docker })
    await pOff.openWorkspaceReader?.({
      threadId: THREAD,
      signal: signal(),
      runAsNonRoot: false,
    })
    expect((readerRun(off.runs) ?? []).join(" ")).not.toContain("--user")

    const explicit = recordingDocker()
    const pExplicit = dockerSandbox({
      scope: SCOPE,
      image: "node:22-slim",
      docker: explicit.docker,
    })
    await pExplicit.openWorkspaceReader?.({
      threadId: THREAD,
      signal: signal(),
      runAsNonRoot: { uid: 501, gid: 20 },
    })
    expect((readerRun(explicit.runs) ?? []).join(" ")).toContain("--user 501:20")
  })

  test("a thread with no workspace storage rejects with the sandbox error code", async () => {
    const { docker, runs } = recordingDocker({ volumeExitCode: 1 })
    const p = dockerSandbox({ scope: SCOPE, image: "node:22-slim", docker })
    await expect(
      p.openWorkspaceReader?.({ threadId: THREAD, signal: signal() }),
    ).rejects.toMatchObject({ code: "B4_E2001" })
    // It must not have started anything before deciding.
    expect(runs.some((r) => r[0] === "run")).toBe(false)
  })

  test("reads route to the reader container, and close removes it exactly once", async () => {
    const { docker, runs, execs } = recordingDocker()
    const p = dockerSandbox({ scope: SCOPE, image: "node:22-slim", docker })
    const reader = await p.openWorkspaceReader?.({ threadId: THREAD, signal: signal() })
    if (!reader) throw new Error("expected a reader")
    const name = (readerRun(runs) ?? [])[(readerRun(runs) ?? []).indexOf("--name") + 1] as string

    await reader.filesystem.listDir("/workspace", {
      signal: signal(),
      workspaceRoot: "/workspace",
    })
    expect(execs.map((e) => e.container)).toEqual([name])

    await reader.close()
    await reader.close()
    expect(runs.filter((r) => r[0] === "rm")).toEqual([["rm", "-f", name]])
  })

  test("the reader surface has no write member and no exec backend", async () => {
    const { docker } = recordingDocker()
    const p = dockerSandbox({ scope: SCOPE, image: "node:22-slim", docker })
    const reader = await p.openWorkspaceReader?.({ threadId: THREAD, signal: signal() })
    if (!reader) throw new Error("expected a reader")
    const surface = reader as unknown as Record<string, unknown>
    expect(surface).not.toHaveProperty("exec")
    for (const member of ["writeFile", "mkdir", "removeFile", "touchFile", "realPath"]) {
      expect(surface.filesystem).not.toHaveProperty(member)
    }
    expect(Object.keys(reader.filesystem).sort()).toEqual([
      "listDir",
      "lstat",
      "readBinaryFile",
      "readBinaryFiles",
      "readFile",
      "statFile",
      "walkTree",
    ])
  })

  test("a volume with no readable host path rejects instead of being recreated", async () => {
    const { docker, runs } = recordingDocker({ mountpoint: "" })
    const p = dockerSandbox({ scope: SCOPE, image: "node:22-slim", docker })
    await expect(
      p.openWorkspaceReader?.({ threadId: THREAD, signal: signal() }),
    ).rejects.toMatchObject({ code: "B4_E2001" })
    expect(runs.some((r) => r[0] === "run")).toBe(false)

    const remote = recordingDocker({ mountpoint: "nfs://elsewhere" })
    const pRemote = dockerSandbox({ scope: SCOPE, image: "node:22-slim", docker: remote.docker })
    await expect(
      pRemote.openWorkspaceReader?.({ threadId: THREAD, signal: signal() }),
    ).rejects.toThrow(/no readable host path/)
    expect(remote.runs.some((r) => r[0] === "run")).toBe(false)
  })

  test("reads after close name the mistake instead of surfacing a docker error", async () => {
    const { docker } = recordingDocker()
    const p = dockerSandbox({ scope: SCOPE, image: "node:22-slim", docker })
    const reader = await p.openWorkspaceReader?.({ threadId: THREAD, signal: signal() })
    if (!reader) throw new Error("expected a reader")
    await reader.close()
    const ctx = { signal: signal(), workspaceRoot: "/workspace" }
    await expect(reader.filesystem.listDir("/workspace", ctx)).rejects.toThrow(/is closed/)
    await expect(reader.filesystem.readFile("/workspace/a", ctx)).rejects.toThrow(/is closed/)
    await expect(reader.filesystem.lstat("/workspace/a", ctx)).rejects.toThrow(/is closed/)
  })

  test("a close that cannot remove the reader reports it and stays retryable", async () => {
    const { docker, runs } = recordingDocker({ removeExitCode: 1 })
    const p = dockerSandbox({ scope: SCOPE, image: "node:22-slim", docker })
    const reader = await p.openWorkspaceReader?.({ threadId: THREAD, signal: signal() })
    if (!reader) throw new Error("expected a reader")
    // A reader that cannot be removed is a leak the caller must hear about.
    await expect(reader.close()).rejects.toMatchObject({ code: "B4_E2001" })
    // Not latched closed: a retry tries the removal again.
    await expect(reader.close()).rejects.toThrow(/could not remove the workspace reader/)
    expect(runs.filter((r) => r[0] === "rm")).toHaveLength(2)
  })

  test("a close whose container is already gone succeeds", async () => {
    const { docker } = recordingDocker({
      removeExitCode: 1,
      removeStderr: "Error: No such container: b4-sbx-rdr-x",
    })
    const p = dockerSandbox({ scope: SCOPE, image: "node:22-slim", docker })
    const reader = await p.openWorkspaceReader?.({ threadId: THREAD, signal: signal() })
    if (!reader) throw new Error("expected a reader")
    await expect(reader.close()).resolves.toBeUndefined()
  })

  test("a failed create reaps the container the caller never received", async () => {
    const failed = recordingDocker({ createExitCode: 125 })
    const pFailed = dockerSandbox({ scope: SCOPE, image: "node:22-slim", docker: failed.docker })
    await expect(
      pFailed.openWorkspaceReader?.({ threadId: THREAD, signal: signal() }),
    ).rejects.toMatchObject({ code: "B4_E2001" })
    const name = (readerRun(failed.runs) ?? [])[
      (readerRun(failed.runs) ?? []).indexOf("--name") + 1
    ] as string
    expect(failed.runs.filter((r) => r[0] === "rm")).toEqual([["rm", "-f", name]])

    // A cancelled `docker run -d` may still have created the container.
    const thrown = new Error("aborted")
    const aborted = recordingDocker({ createThrows: thrown })
    const pAborted = dockerSandbox({ scope: SCOPE, image: "node:22-slim", docker: aborted.docker })
    await expect(
      pAborted.openWorkspaceReader?.({ threadId: THREAD, signal: signal() }),
    ).rejects.toBe(thrown)
    expect(aborted.runs.filter((r) => r[0] === "rm")).toHaveLength(1)
  })

  test("an already-aborted signal rejects before any docker command", async () => {
    const { docker, runs } = recordingDocker()
    const p = dockerSandbox({ scope: SCOPE, image: "node:22-slim", docker })
    const controller = new AbortController()
    controller.abort()
    await expect(
      p.openWorkspaceReader?.({ threadId: THREAD, signal: controller.signal }),
    ).rejects.toThrow()
    expect(runs).toEqual([])
  })
})
