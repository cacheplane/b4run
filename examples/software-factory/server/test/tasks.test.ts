import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { captureTarget } from "../src/targets/archive.ts"
import { loadTask, loadTaskIds } from "../src/targets/catalog.ts"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const apply = (patch: string, cwd: string, ...extra: string[]) =>
  spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", ...extra, patch], {
    cwd,
    encoding: "utf8",
  })

describe("every shipped task", () => {
  for (const id of loadTaskIds()) {
    it(`${id}: its patches apply to the pin, and defect then reference restores the pinned bytes`, async () => {
      const task = loadTask(id)
      const scratch = await mkdtemp(join(tmpdir(), "factory-tasks-"))
      dirs.push(scratch)
      const allowed = task.manifest.allowedSourcePaths[0] as string
      // The pristine pin: the capture without the defect.
      const pristine = captureTarget({ ...task, defectPatch: null }, "reference", {
        appRoot: scratch,
      })
      const before = await readFile(join(pristine.absolute, allowed), "utf8")
      // The baseline the builder sees: the capture with the defect, as the factory makes it.
      const baseline = captureTarget(task, "test", { appRoot: scratch })
      const reference = join(scratch, "reference.patch")
      await writeFile(reference, task.referencePatch)
      expect(
        apply(reference, baseline.absolute, "--check").status,
        "reference applies to the baseline",
      ).toBe(0)
      expect(apply(reference, baseline.absolute).status).toBe(0)
      const after = await readFile(join(baseline.absolute, allowed), "utf8")
      if (task.defectPatch !== null) expect(after).toBe(before)
      else expect(after).not.toBe(before)
    })

    it(`${id}: the independent check names acceptance ids that spec.md carries`, () => {
      const task = loadTask(id)
      for (const name of task.checks.independent.assertions) {
        const acceptance = name.match(/^(A\d+):/)?.[1]
        if (acceptance) expect(task.specText).toContain(`${acceptance}:`)
      }
    })
  }
})

describe("devkit-spawn-deadline", () => {
  it("re-seeds the defect on the spawn-error path only", () => {
    const task = loadTask("devkit-spawn-deadline")
    expect(task.defectPatch).toMatch(/&& closed\) clearTimeout\(timeoutHandle\)/)
    // One hunk, one file, and the termination helper's clearTimeout is untouched.
    expect((task.defectPatch as string).match(/^@@/gm)?.length).toBe(1)
    expect(task.defectPatch).toMatch(/^\+\+\+ b\/packages\/devkit\/src\/testing\/process\.ts$/m)
  })
  it("ships a check that runs the built artifact from the workspace root without tsx", () => {
    const task = loadTask("devkit-spawn-deadline")
    const check = readFileSync(join(task.directory, task.checks.independent.file), "utf8")
    expect(check).toContain("packages/devkit/dist/testing/index.js")
    expect(check).not.toMatch(/\benum\b|\bnamespace\b/)
  })
})
