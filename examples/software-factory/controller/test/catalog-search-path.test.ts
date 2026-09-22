import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  configureCatalog,
  loadTask,
  loadTaskIds,
  resetCatalogForTests,
  tasksDir,
} from "../src/lib/targets/catalog.ts"

let dir: string
afterEach(() => {
  resetCatalogForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe("catalog search path", () => {
  it("finds a generated task after the shipped ones, and the shipped one wins a name clash", () => {
    dir = mkdtempSync(join(tmpdir(), "factory-generated-"))
    // A generated task is a shipped task's directory copied under a new id, minus reference.patch.
    cpSync(join(tasksDir, "devkit-spawn-deadline"), join(dir, "wo-0123456789abcdef"), {
      recursive: true,
    })
    rmSync(join(dir, "wo-0123456789abcdef", "reference.patch"))
    const manifest = JSON.parse(readFileSync(join(dir, "wo-0123456789abcdef", "task.json"), "utf8"))
    writeFileSync(
      join(dir, "wo-0123456789abcdef", "task.json"),
      JSON.stringify({ ...manifest, id: "wo-0123456789abcdef" }),
    )
    // A generated task under a SHIPPED id must never shadow the shipped one.
    cpSync(join(tasksDir, "devkit-spawn-deadline"), join(dir, "devkit-spawn-deadline"), {
      recursive: true,
    })
    configureCatalog({ generatedTasksDir: dir })
    expect(loadTaskIds()).toContain("wo-0123456789abcdef")
    // Shipped ids first, and the clashing id once.
    expect(loadTaskIds()).toEqual([...loadTaskIds(tasksDir), "wo-0123456789abcdef"])
    const task = loadTask("wo-0123456789abcdef")
    expect(task.directory).toBe(join(dir, "wo-0123456789abcdef"))
    expect(task.referencePatch).toBeNull()
    expect(loadTask("devkit-spawn-deadline").directory).toBe(
      join(tasksDir, "devkit-spawn-deadline"),
    )
  })

  it("refuses a generated task that is missing its check or spec, like a shipped one", () => {
    dir = mkdtempSync(join(tmpdir(), "factory-generated-"))
    mkdirSync(join(dir, "wo-aaaaaaaaaaaaaaaa"))
    writeFileSync(
      join(dir, "wo-aaaaaaaaaaaaaaaa", "task.json"),
      JSON.stringify({
        id: "wo-aaaaaaaaaaaaaaaa",
        target: "devkit",
        allowedSourcePaths: ["packages/devkit/src/testing/process.ts"],
        immutablePaths: [],
      }),
    )
    configureCatalog({ generatedTasksDir: dir })
    expect(() => loadTask("wo-aaaaaaaaaaaaaaaa")).toThrow(/checks\.json|ENOENT/)
  })

  it("is unaffected by a generated directory that does not exist yet", () => {
    dir = mkdtempSync(join(tmpdir(), "factory-generated-"))
    configureCatalog({ generatedTasksDir: join(dir, "never-created") })
    expect(loadTaskIds()).toEqual(loadTaskIds(tasksDir))
    expect(() => loadTask("no-such-task")).toThrow(/Unknown task/)
  })

  it("still refuses to answer when the SHIPPED catalog itself is absent", () => {
    dir = mkdtempSync(join(tmpdir(), "factory-generated-"))
    configureCatalog({ generatedTasksDir: dir })
    // An explicit directory is looked up alone, exactly as before the search path existed.
    expect(() => loadTaskIds(join(dir, "missing"))).toThrow(/No task catalog/)
  })
})
