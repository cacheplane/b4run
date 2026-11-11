import { spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { Reporter, TestProject, TestSpecification } from "vitest/node"

const controlled = vi.hoisted(() => ({
  build: vi.fn<() => Promise<readonly { dir: string; name: string }[]>>(),
}))

vi.mock("./helpers/linked-dists.ts", () => ({ buildLinkedDists: controlled.build }))

import { installPreparationReporter, setup } from "./global-setup.ts"

// Resolve the public Vite API through Vitest's declared peer; Vite is not a direct CLI dependency.
const vitestRequire = createRequire(createRequire(import.meta.url).resolve("vitest/package.json"))
const { normalizePath }: { normalizePath: (path: string) => string } = vitestRequire("vite")

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

let root: string
let packageDir: string
let outputs: readonly { dir: string; name: string }[]

beforeEach(async () => {
  root = await mkdtemp(join(process.env.B4_LINKED_DIST_TEST_ARTIFACTS ?? tmpdir(), "b4-dist-prep-"))
  packageDir = join(root, "packages", "mock")
  await mkdir(join(packageDir, "dist"), { recursive: true })
  await writeFile(join(packageDir, "dist", "value.js"), "export const value = 0\n")
  outputs = [{ dir: packageDir, name: "@fixture/mock" }]
  controlled.build.mockReset().mockResolvedValue(outputs)
})

afterEach(async () => {
  if (!process.env.B4_LINKED_DIST_TEST_ARTIFACTS) await rm(root, { recursive: true, force: true })
})

type InstalledReporter = Reporter & {
  inspect(): {
    readers: number
    signatures: number
    writer: boolean
    requestedRevision: number
    retiring: boolean
    terminal: boolean
  }
}

function projectBoundary(
  options: { install?: boolean; rootTypecheck?: boolean; projectTypecheck?: boolean } = {},
) {
  let rerun!: () => Promise<void>
  const restartListeners: (() => void | Promise<void>)[] = []
  const invalidate = vi.fn<(path: string) => void>()
  const vitest = {
    config: {
      reporters: [
        ["default", {}],
        ["json", {}],
      ] as unknown[],
      typecheck: { enabled: options.rootTypecheck ?? false },
    },
    projects: [] as TestProject[],
    invalidateFile: invalidate,
    onServerRestart(callback: () => void | Promise<void>) {
      restartListeners.push(callback)
    },
  }
  const project = {
    config: { typecheck: { enabled: options.projectTypecheck ?? false } },
    onTestsRerun(callback: () => Promise<void>) {
      rerun = callback
    },
    vitest,
  } as unknown as TestProject
  vitest.projects.push(project)
  const specs = (file = "reader-a", taskId = file, pool = "forks") =>
    [{ project, moduleId: file, taskId, pool }] as unknown as TestSpecification[]
  if (options.install !== false) installPreparationReporter(project)
  const reporter = vitest.config.reporters.at(-1) as InstalledReporter
  const start = (selected = specs()) => Promise.resolve(reporter.onTestRunStart?.(selected))
  const end = (selected = specs(), reason: "passed" | "failed" | "interrupted" = "passed") =>
    reporter.onTestRunEnd?.(
      selected.map((spec) => ({
        toTestSpecification: () => ({ ...spec }),
      })) as unknown as Parameters<NonNullable<Reporter["onTestRunEnd"]>>[0],
      [],
      reason,
    )
  return {
    project,
    vitest,
    reporter,
    specs,
    start,
    end,
    invalidate,
    rerun: () => rerun(),
    restart: () => Promise.all(restartListeners.map((listener) => listener())),
    async initial() {
      await start()
      try {
        await setup(project)
      } catch (error) {
        end([], "failed")
        throw error
      }
      end()
    },
  }
}

test("U1: initial preparation holds the boundary until emitted output is current", async () => {
  const gate = deferred()
  controlled.build.mockImplementationOnce(async () => {
    await gate.promise
    await writeFile(join(packageDir, "dist", "value.js"), "export const value = 1\n")
    return outputs
  })
  const boundary = projectBoundary()
  let finished = false
  const preparation = boundary.initial().then(() => {
    finished = true
  })
  await vi.waitFor(() => expect(controlled.build).toHaveBeenCalledTimes(1))
  expect(finished).toBe(false)
  expect(boundary.reporter.inspect()).toMatchObject({ readers: 1, writer: true })
  gate.resolve()
  await preparation
  expect(await readFile(join(packageDir, "dist", "value.js"), "utf8")).toContain("value = 1")
})

test("U2: compiler failure rejects initial setup and a real rerun can recover", async () => {
  const failure = new Error("fixture compiler diagnostic TS9001")
  controlled.build.mockRejectedValueOnce(failure)
  const boundary = projectBoundary()
  const canonicalPackageDir = await realpath(packageDir)
  const expectedPaths = [
    ...new Set(
      [join(packageDir, "dist", "value.js"), join(canonicalPackageDir, "dist", "value.js")].map(
        normalizePath,
      ),
    ),
  ].sort()
  await expect(boundary.initial()).rejects.toBe(failure)
  await boundary.rerun()
  expect(controlled.build).toHaveBeenCalledTimes(2)
  expect(boundary.invalidate.mock.calls.map(([path]) => path)).toEqual(expectedPaths)
})

test("U3: manual rerun cannot rebuild while the previous readers are still active", async () => {
  const boundary = projectBoundary()
  await boundary.initial()
  await boundary.start()
  const rerun = boundary.rerun()
  expect(boundary.reporter.inspect()).toMatchObject({ readers: 1, writer: true })
  // The admitted run can finish while the writer waits on its lease.
  boundary.end()
  await rerun
  expect(controlled.build).toHaveBeenCalledTimes(2)
})

test("U4: rerun invalidates removed and current module paths without skipping later builds", async () => {
  const boundary = projectBoundary()
  const oldPath = join(packageDir, "dist", "value.js")
  const newPath = join(packageDir, "dist", "nested", "value.js")
  // Capture the canonical parent while the old output exists; never resolve a deleted file.
  const canonicalPackageDir = await realpath(packageDir)
  const oldCanonicalPath = normalizePath(join(canonicalPackageDir, "dist", "value.js"))
  const expectedPaths = [
    ...new Set(
      [
        oldPath,
        newPath,
        oldCanonicalPath,
        join(canonicalPackageDir, "dist", "nested", "value.js"),
      ].map(normalizePath),
    ),
  ].sort()
  await boundary.initial()
  controlled.build.mockImplementationOnce(async () => {
    await rm(oldPath)
    await mkdir(dirname(newPath))
    await writeFile(newPath, "export const value = 2\n")
    return outputs
  })
  await boundary.rerun()
  expect(boundary.invalidate.mock.calls.map(([path]) => path)).toEqual(expectedPaths)
  expect(boundary.invalidate).toHaveBeenCalledWith(oldCanonicalPath)
  await boundary.rerun()
  expect(controlled.build).toHaveBeenCalledTimes(3)
})

test("U5: joined requests wait for the last requested build and failure clears the flight", async () => {
  const boundary = projectBoundary()
  await boundary.initial()
  const first = deferred()
  const last = deferred()
  controlled.build
    .mockImplementationOnce(async () => {
      await first.promise
      return outputs
    })
    .mockImplementationOnce(async () => {
      await last.promise
      await writeFile(join(packageDir, "dist", "value.js"), "export const value = 3\n")
      return outputs
    })
  let finished = 0
  const track = (promise: Promise<void>) =>
    promise.then(() => {
      finished += 1
    })
  const requests = [track(boundary.rerun())]
  await vi.waitFor(() => expect(controlled.build).toHaveBeenCalledTimes(2))
  requests.push(track(boundary.rerun()), track(boundary.rerun()))
  expect(boundary.reporter.inspect().requestedRevision).toBe(4)
  first.resolve()
  await vi.waitFor(() => expect(controlled.build).toHaveBeenCalledTimes(3))
  expect(finished).toBe(0)
  last.resolve()
  await Promise.all(requests)
  expect(finished).toBe(3)
  expect(await readFile(join(packageDir, "dist", "value.js"), "utf8")).toContain("value = 3")

  const broken = deferred()
  controlled.build.mockImplementationOnce(async () => {
    await broken.promise
    return outputs
  })
  const failure = new Error("fixture compiler diagnostic TS9002")
  const failures = [boundary.rerun(), boundary.rerun()].map((promise) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    ),
  )
  await vi.waitFor(() => expect(controlled.build).toHaveBeenCalledTimes(4))
  broken.reject(failure)
  expect(await Promise.all(failures)).toEqual([failure, failure])
  await boundary.rerun()
  expect(controlled.build).toHaveBeenCalledTimes(5)
})

test.each(["root", "entry"] as const)("rejects a symlink at the dist %s", async (kind) => {
  const target = join(root, "outside")
  await mkdir(target)
  if (kind === "root") {
    await rm(join(packageDir, "dist"), { recursive: true })
    await symlink(target, join(packageDir, "dist"), "dir")
  } else {
    await symlink(target, join(packageDir, "dist", "linked"), "dir")
  }
  await expect(projectBoundary().initial()).rejects.toThrow(/dist root|non-regular dist/)
})

test("four identical admitted runs keep the writer blocked until all four ends", async () => {
  const boundary = projectBoundary()
  await boundary.initial()
  await Promise.all(Array.from({ length: 4 }, () => boundary.start()))
  const entered = deferred()
  const release = deferred()
  controlled.build.mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
    return outputs
  })
  const writer = boundary.rerun()
  expect(boundary.reporter.inspect()).toMatchObject({ readers: 4, signatures: 1, writer: true })
  for (const readers of [3, 2, 1]) {
    boundary.end()
    expect(boundary.reporter.inspect()).toMatchObject({ readers, writer: true })
  }
  boundary.end()
  await entered.promise
  expect(boundary.reporter.inspect()).toMatchObject({ readers: 0, writer: true })
  release.resolve()
  await writer
  expect(controlled.build).toHaveBeenCalledTimes(2)
})

test("a new start waits behind a published writer, then reads its completed output", async () => {
  const boundary = projectBoundary()
  await boundary.initial()
  const entered = deferred()
  const release = deferred()
  controlled.build.mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
    await writeFile(join(packageDir, "dist", "value.js"), "export const value = 8\n")
    return outputs
  })
  const writer = boundary.rerun()
  await entered.promise
  const reader = boundary.start(boundary.specs("later-reader"))
  expect(boundary.reporter.inspect()).toMatchObject({ readers: 0, writer: true })
  release.resolve()
  await Promise.all([writer, reader])
  expect(await readFile(join(packageDir, "dist", "value.js"), "utf8")).toContain("value = 8")
  expect(boundary.reporter.inspect()).toMatchObject({ readers: 1, writer: false })
  boundary.end(boundary.specs("later-reader"))
})

test("an unmatched end rejects a waiting writer and admission without releasing the real reader", async () => {
  const boundary = projectBoundary()
  await boundary.initial()
  await boundary.start()
  const writer = boundary.rerun().catch((error: unknown) => error)
  const admission = boundary
    .start(boundary.specs("waiting-reader"))
    .catch((error: unknown) => error)
  expect(() => boundary.end(boundary.specs("unmatched-reader"))).toThrow(/Cannot correlate/)
  const [writerError, admissionError] = await Promise.all([writer, admission])
  expect(writerError).toBeInstanceOf(Error)
  expect(admissionError).toBe(writerError)
  expect(boundary.reporter.inspect()).toMatchObject({ readers: 1, terminal: true })
  expect(controlled.build).toHaveBeenCalledTimes(1)
  await expect(boundary.rerun()).rejects.toBe(writerError)
  await expect(boundary.start()).rejects.toBe(writerError)
  // A later matching end may release its own settled reader, never admit work.
  boundary.end()
  expect(boundary.reporter.inspect().readers).toBe(0)
})

test.each(["empty", "partial", "pool", "task", "project"] as const)(
  "unobservable or mismatched %s end fails closed instead of borrowing a reader",
  async (kind) => {
    const boundary = projectBoundary()
    await boundary.initial()
    const selected = [...boundary.specs(), ...boundary.specs("reader-b")]
    await boundary.start(selected)
    const writer = boundary.rerun().catch((error: unknown) => error)
    let reported = selected
    if (kind === "empty") reported = []
    if (kind === "partial") reported = selected.slice(0, 1)
    if (kind === "pool")
      reported = [...boundary.specs("reader-a", "reader-a", "threads"), ...selected.slice(1)]
    if (kind === "task")
      reported = [...boundary.specs("reader-a", "different-task"), ...selected.slice(1)]
    if (kind === "project") {
      const other = projectBoundary()
      reported = [...other.specs(), ...selected.slice(1)]
    }
    expect(() => boundary.end(reported, "interrupted")).toThrow(/Cannot correlate/)
    expect(await writer).toBeInstanceOf(Error)
    expect(boundary.reporter.inspect()).toMatchObject({ readers: 1, terminal: true })
    expect(controlled.build).toHaveBeenCalledTimes(1)
  },
)

test("a duplicate end cannot underflow or release a different signature", async () => {
  const boundary = projectBoundary()
  await boundary.initial()
  const a = boundary.specs()
  const b = boundary.specs("reader-b")
  await boundary.start(a)
  await boundary.start(b)
  boundary.end(a)
  expect(() => boundary.end(a)).toThrow(/Cannot correlate/)
  expect(boundary.reporter.inspect()).toMatchObject({ readers: 1, signatures: 1, terminal: true })
  boundary.end(b)
})

test("another reporter throwing after admission never frees that run's missing lease", async () => {
  const boundary = projectBoundary()
  await boundary.initial()
  const a = boundary.specs()
  const b = boundary.specs("start-failed-reader")
  await boundary.start(a)
  const failure = new Error("third-party start reporter failed")
  await expect(Promise.all([boundary.start(b), Promise.reject(failure)])).rejects.toBe(failure)
  const writer = boundary.rerun().catch((error: unknown) => error)
  boundary.end(a)
  expect(boundary.reporter.inspect()).toMatchObject({ readers: 1, writer: true })
  // An attempted empty end is evidence of lost correlation, never permission
  // to free the missing B lease. Terminal failure also settles the owned writer.
  expect(() => boundary.end([], "failed")).toThrow(/Cannot correlate/)
  expect(await writer).toBeInstanceOf(Error)
  expect(boundary.reporter.inspect()).toMatchObject({ readers: 1, terminal: true })
  expect(controlled.build).toHaveBeenCalledTimes(1)
})

test.each(["root", "selected"] as const)(
  "Vitest typecheck enabled on %s is rejected before installation",
  (where) => {
    const boundary = projectBoundary({
      install: false,
      rootTypecheck: where === "root",
      projectTypecheck: where === "selected",
    })
    expect(() => installPreparationReporter(boundary.project)).toThrow(
      /does not support Vitest typecheck/,
    )
    expect(boundary.vitest.config.reporters).toEqual([
      ["default", {}],
      ["json", {}],
    ])
    expect(controlled.build).not.toHaveBeenCalled()
  },
)

test("a typecheck pool introduced after configuration fails closed without releasing readers", async () => {
  const boundary = projectBoundary()
  await boundary.initial()
  await boundary.start()
  const writer = boundary.rerun().catch((error: unknown) => error)
  await expect(
    boundary.start(boundary.specs("typecheck", "typecheck", "typecheck")),
  ).rejects.toThrow(/typecheck/)
  expect(await writer).toBeInstanceOf(Error)
  expect(boundary.reporter.inspect()).toMatchObject({ readers: 1, terminal: true })
})

test("cold ownership is one-shot and ambiguous concurrent cold readers reject before building", async () => {
  const boundary = projectBoundary()
  await boundary.start()
  await boundary.start(boundary.specs("second-cold-reader"))
  await expect(setup(boundary.project)).rejects.toThrow(/exactly one pre-pool/)
  expect(controlled.build).not.toHaveBeenCalled()
  expect(boundary.reporter.inspect()).toMatchObject({ readers: 2, terminal: true })
  await expect(setup(boundary.project)).rejects.toThrow(/exactly one pre-pool/)
  await expect(boundary.rerun()).rejects.toThrow(/exactly one pre-pool/)
})

test("the initial permit cannot be reused after a successful cold build", async () => {
  const boundary = projectBoundary()
  await boundary.initial()
  await boundary.start()
  await expect(setup(boundary.project)).rejects.toThrow(/permit already consumed/)
  expect(controlled.build).toHaveBeenCalledTimes(1)
  expect(boundary.reporter.inspect()).toMatchObject({ readers: 1, terminal: true })
})

test("a failed startup denies another start and cannot borrow its unmatched end", async () => {
  const boundary = projectBoundary()
  const failure = new Error("cold compiler failed")
  controlled.build.mockRejectedValueOnce(failure)
  await boundary.start()
  await expect(setup(boundary.project)).rejects.toBe(failure)
  await expect(boundary.start(boundary.specs("other-reader"))).rejects.toBe(failure)
  expect(boundary.reporter.inspect()).toMatchObject({ readers: 1, writer: false, terminal: false })
  // Only the captured startup can release its lease. The denied other start
  // never acquired one, so its failed end cannot be borrowed for startup.
  expect(() => boundary.end(boundary.specs("other-reader"), "failed")).toThrow(
    /Cannot correlate failed/,
  )
  expect(boundary.reporter.inspect()).toMatchObject({ readers: 1, terminal: true })
  await expect(boundary.rerun()).rejects.toThrow(/Cannot correlate failed/)
})

test("a captured cold failure accepts only a counted subset of its exact signature", async () => {
  const boundary = projectBoundary()
  const selected = [...boundary.specs(), ...boundary.specs("reader-b")]
  controlled.build.mockRejectedValueOnce(new Error("cold compiler failed"))
  await boundary.start(selected)
  await expect(setup(boundary.project)).rejects.toThrow("cold compiler failed")
  boundary.end(selected.slice(1), "failed")
  expect(boundary.reporter.inspect()).toMatchObject({ readers: 0, terminal: false })
  await boundary.rerun()
  expect(controlled.build).toHaveBeenCalledTimes(2)
})

test.each(["missing", "duplicate"] as const)(
  "%s capability leaves memoized setup reruns rejecting",
  async (kind) => {
    const boundary = projectBoundary({ install: kind !== "missing" })
    if (kind === "duplicate") boundary.vitest.config.reporters.push(boundary.reporter)
    await expect(setup(boundary.project)).rejects.toThrow(/exactly one/)
    await expect(boundary.rerun()).rejects.toThrow(/exactly one/)
    expect(controlled.build).not.toHaveBeenCalled()
  },
)

test("missing output is a real cold failure followed by a genuinely new build", async () => {
  const boundary = projectBoundary()
  await rm(join(packageDir, "dist"), { recursive: true })
  await expect(boundary.initial()).rejects.toThrow(/ENOENT/)
  await mkdir(join(packageDir, "dist"))
  await writeFile(join(packageDir, "dist", "value.js"), "export const value = 9\n")
  await boundary.rerun()
  expect(controlled.build).toHaveBeenCalledTimes(2)
})

test("public restart retires the old coordinator after its writer and readers settle", async () => {
  const boundary = projectBoundary()
  await boundary.initial()
  await boundary.start()
  const entered = deferred()
  const release = deferred()
  controlled.build.mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
    return outputs
  })
  const writer = boundary.rerun()
  const retirement = boundary.restart()
  expect(boundary.reporter.inspect()).toMatchObject({ readers: 1, writer: true, retiring: true })
  await expect(boundary.start()).rejects.toThrow(/retiring/)
  boundary.end()
  await entered.promise
  release.resolve()
  await Promise.all([writer, retirement])
  const fresh = projectBoundary()
  expect(fresh.reporter).not.toBe(boundary.reporter)
  expect(fresh.reporter.inspect()).toMatchObject({
    readers: 0,
    writer: false,
    requestedRevision: 0,
  })
  expect(fresh.vitest.config.reporters.slice(0, 2)).toEqual([
    ["default", {}],
    ["json", {}],
  ])
  await fresh.initial()
  expect(controlled.build).toHaveBeenCalledTimes(3)
})

test.each(["cold", "ordinary"] as const)(
  "a failed %s preparation denies direct starts until a later requested build succeeds",
  async (kind) => {
    const boundary = projectBoundary()
    if (kind === "ordinary") await boundary.initial()
    const failure = new Error("fixture compiler diagnostic TS9004")
    controlled.build.mockRejectedValueOnce(failure)
    await expect(kind === "cold" ? boundary.initial() : boundary.rerun()).rejects.toBe(failure)
    const failedBuilds = controlled.build.mock.calls.length
    await expect(boundary.start()).rejects.toBe(failure)
    expect(boundary.reporter.inspect()).toMatchObject({
      readers: 0,
      writer: false,
      terminal: false,
    })
    expect(controlled.build).toHaveBeenCalledTimes(failedBuilds)

    const entered = deferred()
    const release = deferred()
    controlled.build.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      await writeFile(join(packageDir, "dist", "value.js"), "export const value = 12\n")
      return outputs
    })
    const recovery = boundary.rerun()
    await entered.promise
    // A direct start during the genuine recovery waits for that writer rather
    // than being permanently poisoned by the previous compiler failure.
    const later = boundary.start(boundary.specs("recovered-reader"))
    expect(boundary.reporter.inspect()).toMatchObject({ readers: 0, writer: true })
    release.resolve()
    await Promise.all([recovery, later])
    expect(await readFile(join(packageDir, "dist", "value.js"), "utf8")).toContain("value = 12")
    expect(boundary.reporter.inspect()).toMatchObject({
      readers: 1,
      writer: false,
      terminal: false,
    })
    expect(controlled.build).toHaveBeenCalledTimes(failedBuilds + 1)
    boundary.end(boundary.specs("recovered-reader"))
  },
)

test.each(["output", "invalidation"] as const)(
  "a failed %s check keeps admission closed until the whole later preparation succeeds",
  async (kind) => {
    const boundary = projectBoundary()
    await boundary.initial()
    if (kind === "output") {
      controlled.build.mockImplementationOnce(async () => {
        await rm(join(packageDir, "dist"), { recursive: true })
        return outputs
      })
    } else {
      boundary.invalidate.mockImplementationOnce(() => {
        throw new Error("fixture public invalidation failed")
      })
    }
    const failure = await boundary.rerun().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    await expect(boundary.start()).rejects.toBe(failure)
    expect(boundary.reporter.inspect()).toMatchObject({
      readers: 0,
      writer: false,
      terminal: false,
    })
    expect(controlled.build).toHaveBeenCalledTimes(2)
    if (kind === "output") {
      await mkdir(join(packageDir, "dist"))
      await writeFile(join(packageDir, "dist", "value.js"), "export const value = 13\n")
    }
    await boundary.rerun()
    await boundary.start()
    expect(controlled.build).toHaveBeenCalledTimes(3)
    expect(boundary.reporter.inspect()).toMatchObject({ readers: 1, terminal: false })
    boundary.end()
  },
)

test("a rerun queued at final invalidation builds its later requested input", async () => {
  const boundary = projectBoundary()
  let requestedValue = 1
  controlled.build.mockImplementation(async () => {
    const value = requestedValue
    await writeFile(join(packageDir, "dist", "value.js"), `export const value = ${value}\n`)
    return outputs
  })
  await boundary.initial()
  const lateRequested = deferred()
  let late!: Promise<void>
  boundary.invalidate.mockImplementationOnce(() => {
    // This schedules an independent public rerun request at the writer's final
    // invalidation boundary; real invalidateFile need not emit any callback.
    queueMicrotask(() => {
      requestedValue = 3
      late = boundary.rerun()
      lateRequested.resolve()
    })
  })
  requestedValue = 2
  const first = boundary.rerun()
  await lateRequested.promise
  await Promise.all([first, late])
  expect(controlled.build).toHaveBeenCalledTimes(3)
  expect(await readFile(join(packageDir, "dist", "value.js"), "utf8")).toContain("value = 3")
  await boundary.start()
  expect(boundary.reporter.inspect()).toMatchObject({
    readers: 1,
    writer: false,
    requestedRevision: 3,
    terminal: false,
  })
  boundary.end()
})

test.each([
  "initial-watch",
  "failed-build",
  "programmatic-coalescing",
  "later-reader-admission",
  "alias-path",
])(
  "real two-project Vitest lifecycle: %s",
  async (mode) => {
    const stdoutPath = join(root, "driver.stdout")
    const stderrPath = join(root, "driver.stderr")
    const stdout = openSync(stdoutPath, "wx", 0o600)
    const stderr = openSync(stderrPath, "wx", 0o600)
    const child = (() => {
      try {
        return spawn(
          process.execPath,
          [
            join(import.meta.dirname, "helpers", "linked-dist-preparation-driver.mjs"),
            mode,
            root,
            join(import.meta.dirname, "global-setup.ts"),
          ],
          {
            cwd: resolve(import.meta.dirname, "../../.."),
            env: {
              HOME: root,
              TMPDIR: root,
              PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
              CI: "1",
              NO_COLOR: "1",
              B4_TELEMETRY_DISABLED: "1",
            },
            stdio: ["ignore", stdout, stderr],
          },
        )
      } finally {
        closeSync(stdout)
        closeSync(stderr)
      }
    })()
    const closed = await new Promise<{ code: number | null; signal: string | null }>((yes, no) => {
      child.once("error", no)
      child.once("close", (code, signal) => yes({ code, signal }))
    })
    const rawOut = await readFile(stdoutPath, "utf8")
    const rawErr = await readFile(stderrPath, "utf8")
    expect(closed, rawOut + rawErr).toEqual({ code: 0, signal: null })
    const line = rawOut
      .split("\n")
      .reverse()
      .find((value) => value.startsWith("CONTROL_RESULT="))
    expect(line, rawOut + rawErr).toBeDefined()
    const result = JSON.parse(line?.slice("CONTROL_RESULT=".length) ?? "{}")
    expect(result).toMatchObject({ ok: true, mode, maximumWriters: 1, closed: true })
    if (mode === "failed-build") {
      expect([null, 0]).toContain(result.failedBuildTransition.before)
      expect(result.failedBuildTransition).toEqual({
        before: result.failedBuildTransition.before,
        afterExpectedFailure: 1,
        restoredBeforeRecovery: result.failedBuildTransition.before,
        initialRun: { reason: "failed", moduleCount: 0, states: [], errors: 0 },
        recoveryRun: {
          reason: "passed",
          moduleCount: 4,
          states: ["passed", "passed", "passed", "passed"],
          errors: 0,
        },
        afterRecovery: result.failedBuildTransition.before,
        afterClose: result.failedBuildTransition.before,
      })
    }
  },
  30_000,
)

test.each(["direct", "workspace", "restart", "cold-failure", "ordinary-failure"])(
  "real CLI config preserves preparation admission and default/JSON reporters: %s",
  async (mode) => {
    const stdoutPath = join(root, "wiring.stdout")
    const stderrPath = join(root, "wiring.stderr")
    const stdout = openSync(stdoutPath, "wx", 0o600)
    const stderr = openSync(stderrPath, "wx", 0o600)
    const child = (() => {
      try {
        return spawn(
          process.execPath,
          [
            join(import.meta.dirname, "helpers", "linked-dist-wiring-driver.mjs"),
            mode,
            root,
            join(import.meta.dirname, "global-setup.ts"),
            resolve(import.meta.dirname, "../vitest.config.ts"),
            resolve(import.meta.dirname, "../../../vitest.workspace.ts"),
          ],
          {
            cwd: resolve(import.meta.dirname, "../../.."),
            env: {
              HOME: root,
              TMPDIR: root,
              PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
              CI: "1",
              NO_COLOR: "1",
              B4_TELEMETRY_DISABLED: "1",
            },
            stdio: ["ignore", stdout, stderr],
          },
        )
      } finally {
        closeSync(stdout)
        closeSync(stderr)
      }
    })()
    const closed = await new Promise<{ code: number | null; signal: string | null }>((yes, no) => {
      child.once("error", no)
      child.once("close", (code, signal) => yes({ code, signal }))
    })
    const rawOut = await readFile(stdoutPath, "utf8")
    const rawErr = await readFile(stderrPath, "utf8")
    expect(closed, rawOut + rawErr).toEqual({ code: 0, signal: null })
    const line = rawOut
      .split("\n")
      .reverse()
      .find((value) => value.startsWith("WIRING_RESULT="))
    expect(line, rawOut + rawErr).toBeDefined()
    const result = JSON.parse(line?.slice("WIRING_RESULT=".length) ?? "{}")
    expect(result).toMatchObject({ ok: true, mode, maximumWriters: 1, closed: true })
  },
  30_000,
)
