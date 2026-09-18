import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  fixtureWorkspace,
  sandboxImage,
  sandboxPolicy,
  workspaceInspectionOptions,
} from "../src/fixtures/workspace.ts"
import {
  createHandleWorkspaceReader,
  createThreadWorkspaceReader,
  THREAD_WORKSPACE_READER_GAP,
} from "../src/worker/workspace-reader.ts"
import { createFakeWorkspaceReader } from "./fake-workspace-reader.ts"

/** Every read names the thread AND the task: inspection options are per task. */
const target = (threadId: string, taskId = "cli-flags") => ({ threadId, taskId })

/**
 * The environment identity a bundle binds is this value, verbatim. It is a tag, not the
 * pinned digest the spec asks for, and the README has to say so: a reader who is told the
 * bundle "binds the verifier's environment" would otherwise reasonably assume the binding
 * survives the tag being repointed at a different image. It does not.
 */
describe("the sandbox image is the environment identity", () => {
  it("is a mutable tag, and the README says the pinned-digest requirement is unmet", () => {
    expect(sandboxImage).toBe(process.env.FACTORY_SANDBOX_IMAGE ?? "b4-code-fixer:fixture-v1")
    expect(sandboxImage).not.toMatch(/@sha256:/)
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8")
    const row = readme.split("\n").find((line) => line.startsWith("| `FACTORY_SANDBOX_IMAGE`"))
    expect(row).toBeDefined()
    expect(row).toMatch(/rewrites the environment identity/)
    expect(row).toMatch(/mutable tag/)
    expect(row).toMatch(/pinned image digest/)
    expect(row).toMatch(/does not meet/)
  })
})

describe("fixture workspace definition", () => {
  it("captures only the declared inventory and never the checks", () => {
    const definition = fixtureWorkspace("cli-flags")
    expect(definition.source.directory).toBe("fixtures/cli-flags/project")
    expect(definition.source.include).toContain("src/cli.ts")
    expect(definition.source.include).toContain("test/cli.test.ts")
    for (const path of definition.source.include) expect(path.startsWith("checks/")).toBe(false)
    expect(definition.baseline).toBe("git")
  })

  it("denies the network and bounds the container", () => {
    expect(sandboxPolicy.network.mode).toBe("deny")
    expect(sandboxPolicy.resources?.timeoutMs).toBeGreaterThan(0)
  })
})

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

describe("the real thread workspace reader", () => {
  it("refuses honestly, in terms an operator can act on", async () => {
    const reader = createThreadWorkspaceReader(workspaceInspectionOptions)
    // The placeholder never invents bytes. It names the surface it needs, where that
    // surface is being added, and what the controller will do meanwhile, so a shelf of
    // verification_inconclusive work orders has a stated cause rather than a suspicion.
    await expect(reader.read(target("t-1"), AbortSignal.timeout(1_000))).rejects.toThrow(/t-1/)
    await expect(reader.read(target("t-1"), AbortSignal.timeout(1_000))).rejects.toThrow(
      /openWorkspaceReader/,
    )
    expect(THREAD_WORKSPACE_READER_GAP).toMatch(/#731/)
    expect(THREAD_WORKSPACE_READER_GAP).toMatch(/verification_inconclusive/)
  })
})

/**
 * The swap-in promise the README makes: when pull request #731 lands,
 * `createThreadWorkspaceReader` becomes `createHandleWorkspaceReader` over the new surface
 * and NOTHING else moves. That was not true while the two structural inspection options
 * defaulted to absent and the command line supplied neither: the replacement would have
 * thrown on the dependency symlink, or reported the git directory as added paths, which is
 * a scope violation on every run. Both readers now require the same options provider, and
 * the options are derived from the workspace definition rather than restated.
 */
describe("inspection options travel with the reader", () => {
  it("derives the git exclusion and the dependency symlink from the workspace definition", () => {
    const definition = fixtureWorkspace("cli-flags")
    const options = workspaceInspectionOptions("cli-flags")
    expect(definition.baseline).toBe("git")
    expect(options.excludeRootDirectories).toEqual([".git"])
    expect(options.expectedRootSymlinks).toEqual({
      node_modules: "/opt/fixtures/cli-flags/node_modules",
    })
    // Derived, not restated: every link in the definition has an expectation.
    for (const link of definition.environmentLinks ?? [])
      expect(options.expectedRootSymlinks[link.path]).toBe(link.target)
  })

  it("is described in the README by the options the replacement must carry", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8")
    expect(readme).toMatch(/excludeRootDirectories/)
    expect(readme).toMatch(/expectedRootSymlinks/)
    expect(readme).toMatch(/WorkspaceInspectionOptions/)
  })

  it("refuses an unknown task before it attaches to anything", async () => {
    const reader = createThreadWorkspaceReader(workspaceInspectionOptions)
    await expect(
      reader.read(target("t-1", "no-such-task"), AbortSignal.timeout(1_000)),
    ).rejects.toThrow(/Unknown fixture/)
  })

  it("resolves the options before attaching, so both readers refuse the same way", async () => {
    let attached = false
    const asked: string[] = []
    const reader = createHandleWorkspaceReader(
      async () => {
        attached = true
        throw new Error("attach must not be reached")
      },
      (taskId) => {
        asked.push(taskId)
        return workspaceInspectionOptions(taskId)
      },
    )
    await expect(
      reader.read(target("t-1", "no-such-task"), AbortSignal.timeout(1_000)),
    ).rejects.toThrow(/Unknown fixture/)
    expect(asked).toEqual(["no-such-task"])
    expect(attached).toBe(false)
  })
})
