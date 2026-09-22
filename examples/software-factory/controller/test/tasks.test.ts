import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { captureTarget } from "../src/lib/targets/archive.ts"
import { loadTask, loadTaskIds } from "../src/lib/targets/catalog.ts"

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
      // The pristine pin: the capture without the defect.
      const pristine = captureTarget({ ...task, defectPatch: null }, "reference", {
        appRoot: scratch,
      })
      // The baseline the builder sees: the capture with the defect, as the factory makes it.
      const baseline = captureTarget(task, "test", { appRoot: scratch })
      const reference = join(scratch, "reference.patch")
      await writeFile(reference, task.referencePatch)
      expect(
        apply(reference, baseline.absolute, "--check").status,
        "reference applies to the baseline",
      ).toBe(0)
      expect(apply(reference, baseline.absolute).status).toBe(0)
      // Every allowed path, not just the first: a task whose reference touches a second
      // editable file would otherwise round-trip only the one this law happened to read.
      const differing: string[] = []
      for (const allowed of task.manifest.allowedSourcePaths) {
        const before = await readFile(join(pristine.absolute, allowed), "utf8")
        const after = await readFile(join(baseline.absolute, allowed), "utf8")
        if (task.defectPatch !== null)
          expect(after, `${allowed} round-trips to the pin`).toBe(before)
        else if (after !== before) differing.push(allowed)
      }
      // A task with no defect patch is repaired forward: the reference must change something.
      if (task.defectPatch === null) expect(differing.length).toBeGreaterThan(0)
    })

    it(`${id}: the independent check names acceptance ids that spec.md carries`, () => {
      const task = loadTask(id)
      for (const name of task.checks.independent.assertions) {
        const acceptance = name.match(/^(A\d+):/)?.[1]
        if (acceptance) expect(task.specText).toContain(`${acceptance}:`)
      }
      // `cli-flags` is grandfathered: rung 1 shipped its independent assertions with prose
      // names before the `A<n>:` convention existed, and renaming them would move its
      // specificationDigest. Every task written since must carry the convention, so a new
      // task's independent evidence can always be traced back to a numbered criterion.
      if (id === "cli-flags") return
      expect(
        task.checks.independent.assertions.some((name) => /^A\d+:/.test(name)),
        "at least one independent assertion is prefixed with an A<n> acceptance id",
      ).toBe(true)
    })
  }
})

describe("devkit-spawn-deadline", () => {
  it("re-seeds the defect on the spawn-error path only", () => {
    const task = loadTask("devkit-spawn-deadline")
    expect(task.defectPatch).toMatch(/&& closed\) clearTimeout\(timeoutHandle\)/)
    // Pinned to the asynchronous-spawn-error arm: the hunk's context is the `throw` that
    // rethrows as `"spawn"`, so a patch re-anchored onto the timeout or close path (where a
    // dangling timer is harmless) no longer counts as this defect.
    expect(task.defectPatch).toContain('"spawn", error)')
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
