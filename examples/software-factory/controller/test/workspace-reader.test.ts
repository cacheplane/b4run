import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SandboxProvider, SandboxWorkspaceReader } from "@b4run/workspace"
import { afterEach, describe, expect, it } from "vitest"
import { loadTask } from "../src/lib/targets/catalog.ts"
import { targetInspectionOptions, targetSandboxPolicy } from "../src/lib/targets/workspace.ts"
import {
  createThreadWorkspaceReader,
  InvalidWorkspaceRootError,
  type WorkspaceReadOptions,
  WorkspaceRootMissingError,
} from "../src/lib/worker/workspace-reader.ts"
import { fakeManagedApp } from "./fake-managed-provider.ts"
import { createFakeWorkspaceReader } from "./fake-workspace-reader.ts"

/** Every read names the thread AND the task: inspection options are per task. */
const target = (threadId: string, taskId = "cli-flags") => ({ threadId, taskId })

/** The task's own inspection options, as the controller derives them (the builder's reader). */
const inspectionOptions = (taskId: string | undefined) => {
  if (taskId === undefined) throw new Error("the builder reader needs a task")
  return targetInspectionOptions(loadTask(taskId))
}

describe("fake workspace reader", () => {
  it("returns the scripted bytes for a thread and rejects an unknown one", async () => {
    const reader = createFakeWorkspaceReader({ "t-1": { "src/cli.ts": "fixed\n" } })
    expect(await reader.read(target("t-1"), AbortSignal.timeout(1_000))).toEqual(
      new Map([["src/cli.ts", "fixed\n"]]),
    )
    await expect(reader.read(target("t-2"), AbortSignal.timeout(1_000))).rejects.toThrow(/t-2/)
  })

  it("records every thread it was asked to read", async () => {
    const reader = createFakeWorkspaceReader({ "t-1": {} })
    await reader.read(target("t-1"), AbortSignal.timeout(1_000))
    expect(reader.reads).toEqual(["t-1"])
  })
})

/**
 * What can be proven without Docker. The builder's threads are managed workspaces, so the
 * wiring under test is: resolve the thread through the builder's installation store, open
 * the published record's storage through the provider's managed reader, pass the inspection
 * options through, close. What an in-memory volume cannot model is symlinks, which is why
 * `expectedRootSymlinks` is proven positively only against real Docker (see
 * `end-to-end.integration.test.ts`) and here only by the refusal it produces when the link
 * it names is absent.
 */
describe("the real thread workspace reader", () => {
  /** Options shaped like the target's, minus the symlink the in-memory volume cannot hold. */
  const fakeOptions = (): WorkspaceReadOptions => ({
    excludeRootDirectories: [".git"],
    expectedRootSymlinks: {},
  })

  const apps: Array<Awaited<ReturnType<typeof fakeManagedApp>>> = []
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close()
  })

  /** A builder app whose thread `t-1` holds a published workspace with a git directory in its root. */
  const withThread = async () => {
    const app = await fakeManagedApp()
    apps.push(app)
    await app.seed("t-1", { "src/cli.ts": "fixed\n", ".git/HEAD": "ref: refs/heads/main\n" })
    return app
  }

  /** The reader resolves a provider per task; this app's one provider serves every task. */
  const sourceOf = (app: Awaited<ReturnType<typeof withThread>>) => ({
    appRoot: app.appRoot,
    providerFor: () => app.provider,
  })

  it("reads the thread's own bytes", async () => {
    const reader = createThreadWorkspaceReader(sourceOf(await withThread()), fakeOptions)
    expect(await reader.read(target("t-1"), AbortSignal.timeout(5_000))).toEqual(
      new Map([["src/cli.ts", "fixed\n"]]),
    )
  })

  it("carries excludeRootDirectories through, so the git baseline is not a candidate change", async () => {
    const app = await withThread()
    const kept = createThreadWorkspaceReader(sourceOf(app), () => ({
      excludeRootDirectories: [],
      expectedRootSymlinks: {},
    }))
    // Without the option the git directory arrives as added paths — a scope violation on
    // every run — which is what proves the option is not quietly dropped.
    expect([...(await kept.read(target("t-1"), AbortSignal.timeout(5_000))).keys()]).toContain(
      ".git/HEAD",
    )
  })

  it("drops paths under ignorePrefixes, so the target's build output is not an added path", async () => {
    const app = await fakeManagedApp()
    apps.push(app)
    await app.seed("t-1", {
      "src/a.ts": "source\n",
      "packages/x/dist/a.js": "built\n",
      "packages/x/dist-notes.ts": "not build output\n",
    })
    const reader = createThreadWorkspaceReader(sourceOf(app), () => ({
      ...fakeOptions(),
      ignorePrefixes: ["packages/x/dist/"],
    }))
    // A prefix match, not a path-segment one by accident: `dist-notes.ts` shares the first
    // characters of the directory prefix and is NOT build output, so it survives.
    expect(
      [...(await reader.read(target("t-1"), AbortSignal.timeout(5_000))).keys()].sort(),
    ).toEqual(["packages/x/dist-notes.ts", "src/a.ts"])
  })

  it("carries expectedRootSymlinks through, and refuses when the link it names is absent", async () => {
    const reader = createThreadWorkspaceReader(sourceOf(await withThread()), inspectionOptions)
    await expect(reader.read(target("t-1"), AbortSignal.timeout(5_000))).rejects.toThrow(
      /Missing expected root symlink: node_modules/,
    )
  })

  it("refuses a thread the builder has never seen rather than reporting an empty one", async () => {
    const reader = createThreadWorkspaceReader(sourceOf(await withThread()), fakeOptions)
    // "Produced nothing" and "never existed" are different facts to a verifier: the first is
    // a candidate with no changes, the second is the controller not knowing.
    await expect(reader.read(target("t-2"), AbortSignal.timeout(5_000))).rejects.toThrow(
      /No managed workspace for thread "t-2"/,
    )
  })

  it("refuses a provider without the managed read capability, naming it", async () => {
    const app = await withThread()
    const { openWorkspaceReader: _omitted, ...workspaces } = app.provider.workspaces as NonNullable<
      SandboxProvider["workspaces"]
    >
    const reader = createThreadWorkspaceReader(
      { appRoot: app.appRoot, providerFor: () => ({ ...app.provider, workspaces }) },
      fakeOptions,
    )
    await expect(reader.read(target("t-1"), AbortSignal.timeout(5_000))).rejects.toThrow(
      /"fake-managed" does not support reading a workspace/,
    )
  })

  it("refuses an app root where no builder has ever run", async () => {
    const app = await withThread()
    const empty = await mkdtemp(join(tmpdir(), "factory-no-builder-"))
    try {
      const reader = createThreadWorkspaceReader(
        { appRoot: empty, providerFor: () => app.provider },
        fakeOptions,
      )
      await expect(reader.read(target("t-1"), AbortSignal.timeout(5_000))).rejects.toThrow(
        /No workspace installation/,
      )
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

/**
 * The two structural inspection options are required rather than defaulted-absent: the
 * workspace has a git baseline and a dependency symlink, so a reader without them throws on
 * the symlink or reports the git directory as added paths — a scope violation on every run.
 * They are derived from the workspace definition rather than restated by each caller, and
 * the reader identity is derived from the builder's own sandbox policy for the same reason.
 */
describe("inspection options travel with the reader", () => {
  it("is described in the README by the options the replacement must carry", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8")
    expect(readme).toMatch(/excludeRootDirectories/)
    expect(readme).toMatch(/expectedRootSymlinks/)
    expect(readme).toMatch(/WorkspaceInspectionOptions/)
  })

  it("mirrors the builder's sandbox policy identity, so the reader can read what the builder wrote", () => {
    const task = loadTask("cli-flags")
    expect(targetInspectionOptions(task).runAsNonRoot).toBe(
      targetSandboxPolicy(task.target).security?.runAsNonRoot,
    )
  })

  it("refuses an unknown task before it opens anything", async () => {
    let opened = false
    const app = await fakeManagedApp()
    try {
      await app.seed("t-1", {})
      const workspaces = app.provider.workspaces as NonNullable<SandboxProvider["workspaces"]>
      const reader = createThreadWorkspaceReader(
        {
          appRoot: app.appRoot,
          providerFor: () => ({
            ...app.provider,
            workspaces: {
              ...workspaces,
              openWorkspaceReader(input) {
                opened = true
                return (
                  workspaces.openWorkspaceReader as NonNullable<
                    typeof workspaces.openWorkspaceReader
                  >
                )(input)
              },
            },
          }),
        },
        inspectionOptions,
      )
      await expect(
        reader.read(target("t-1", "no-such-task"), AbortSignal.timeout(1_000)),
      ).rejects.toThrow(/Unknown task/)
      expect(opened).toBe(false)
    } finally {
      await app.close()
    }
  })
})

/**
 * The drafter's thread holds the wide capture under `repo/` (executables, more bytes than
 * an inspection allows) next to the four files it writes under `draft/`. The controller
 * reads that thread re-rooted at `draft/`: inspection starts there, so `repo/` is never
 * walked, and the keys come back `draft/`-prefixed so the parser sees the tree it expects.
 */
describe("the re-rooted read", () => {
  const apps: Array<Awaited<ReturnType<typeof fakeManagedApp>>> = []
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close()
  })

  const options = (root?: string): WorkspaceReadOptions => ({
    excludeRootDirectories: [],
    expectedRootSymlinks: {},
    ...(root === undefined ? {} : { root }),
  })

  /**
   * A drafter thread with an executable under `repo/`, recording every path the filesystem
   * is asked about. The in-memory volume cannot hold an executable bit, so the reader the
   * provider opens is wrapped: `repo/bin/tool` reports itself executable.
   */
  const drafterThread = async (files: Record<string, string>) => {
    const app = await fakeManagedApp()
    apps.push(app)
    await app.seed("t-1", files)
    const touched: string[] = []
    const workspaces = app.provider.workspaces as NonNullable<SandboxProvider["workspaces"]>
    const open = workspaces.openWorkspaceReader as NonNullable<
      typeof workspaces.openWorkspaceReader
    >
    const provider: SandboxProvider = {
      ...app.provider,
      workspaces: {
        ...workspaces,
        async openWorkspaceReader(input) {
          const reader = await open.call(workspaces, input)
          const fs = reader.filesystem
          const recorded: SandboxWorkspaceReader["filesystem"] = {
            ...fs,
            async lstat(path, ctx) {
              touched.push(path)
              const metadata = await fs.lstat(path, ctx)
              return path.endsWith("/repo/bin/tool") ? { ...metadata, executable: true } : metadata
            },
            listDir(path, ctx) {
              touched.push(path)
              return fs.listDir(path, ctx)
            },
            readBinaryFile(path, ctx, opts) {
              touched.push(path)
              return fs.readBinaryFile(path, ctx, opts)
            },
          }
          return { ...reader, filesystem: recorded }
        },
      },
    }
    return { source: { appRoot: app.appRoot, providerFor: () => provider }, touched }
  }
  const wide = { "repo/bin/tool": "#!/bin/sh\n", "repo/src/a.ts": "a\n", "draft/task.json": "{}\n" }

  it("returns only draft/, prefixed, and never stats repo/", async () => {
    const { source, touched } = await drafterThread(wide)
    const reader = createThreadWorkspaceReader(source, () => options("draft"))
    expect(await reader.read({ threadId: "t-1" }, AbortSignal.timeout(5_000))).toEqual(
      new Map([["draft/task.json", "{}\n"]]),
    )
    expect(touched.some((path) => path.includes("/repo"))).toBe(false)
    expect(touched).toContain("/workspace/draft/task.json")
  })

  it("is what makes the wide capture readable: the same thread without a root throws on the executable", async () => {
    const { source } = await drafterThread(wide)
    const reader = createThreadWorkspaceReader(source, () => options())
    await expect(reader.read({ threadId: "t-1" }, AbortSignal.timeout(5_000))).rejects.toThrow(
      /Executable workspace file: repo\/bin\/tool/,
    )
  })

  it("reports a missing root as WorkspaceRootMissingError, distinct from a failed read", async () => {
    const { source, touched } = await drafterThread({ "repo/bin/tool": "#!/bin/sh\n" })
    const reader = createThreadWorkspaceReader(source, () => options("draft"))
    const failure = await reader.read({ threadId: "t-1" }, AbortSignal.timeout(5_000)).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(WorkspaceRootMissingError)
    expect((failure as WorkspaceRootMissingError).root).toBe("draft")
    expect((failure as WorkspaceRootMissingError).kind).toBe("absent")
    expect(touched.some((path) => path.includes("/repo"))).toBe(false)
  })

  it("reports a root that is a file, not a directory, the same way", async () => {
    const { source } = await drafterThread({ draft: "not a directory\n" })
    const reader = createThreadWorkspaceReader(source, () => options("draft"))
    await expect(
      reader.read({ threadId: "t-1" }, AbortSignal.timeout(5_000)),
    ).rejects.toMatchObject({
      name: "WorkspaceRootMissingError",
      kind: "not_directory",
      root: "draft",
    })
  })

  it("reads a nested root and prefixes with the whole of it", async () => {
    const { source } = await drafterThread({ "out/draft/task.json": "{}\n", "out/other": "x\n" })
    const reader = createThreadWorkspaceReader(source, () => options("out/draft"))
    expect(await reader.read({ threadId: "t-1" }, AbortSignal.timeout(5_000))).toEqual(
      new Map([["out/draft/task.json", "{}\n"]]),
    )
  })

  it("refuses a root that is not a canonical relative directory, before it opens anything", async () => {
    let opened = false
    const app = await fakeManagedApp()
    apps.push(app)
    await app.seed("t-1", { "draft/task.json": "{}\n" })
    const workspaces = app.provider.workspaces as NonNullable<SandboxProvider["workspaces"]>
    const source = {
      appRoot: app.appRoot,
      providerFor: () => ({
        ...app.provider,
        workspaces: {
          ...workspaces,
          openWorkspaceReader(
            input: Parameters<NonNullable<typeof workspaces.openWorkspaceReader>>[0],
          ) {
            opened = true
            return (
              workspaces.openWorkspaceReader as NonNullable<typeof workspaces.openWorkspaceReader>
            )(input)
          },
        },
      }),
    }
    for (const root of ["..", "draft/..", "/draft", "draft\0", "", "draft/", "./draft", "a\\b"]) {
      const reader = createThreadWorkspaceReader(source, () => options(root))
      await expect(reader.read({ threadId: "t-1" }, AbortSignal.timeout(1_000))).rejects.toThrow(
        InvalidWorkspaceRootError,
      )
    }
    expect(opened).toBe(false)
  })
})
