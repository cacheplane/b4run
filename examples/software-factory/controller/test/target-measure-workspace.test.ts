import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadTargetRecipe } from "../src/lib/targets/catalog.ts"
import { initTarget } from "../src/lib/targets/init/init.ts"
import { writeProposal } from "../src/lib/targets/proposal.ts"
import { targetInspectionOptions, targetWorkspace } from "../src/lib/targets/workspace.ts"
import { cleanupPinRepos, MINI, pinRepo } from "./pin-repo.ts"

const dirs: string[] = []
afterEach(() => {
  cleanupPinRepos()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

describe("a workspace for target:measure", () => {
  it("captures a generated target with no task behind it, and inspects it as the verifier does", () => {
    const { root, pin } = pinRepo(MINI)
    const targets = temp("factory-measure-targets-")
    writeProposal(
      initTarget({ packageRef: "@m/app", pin, repositoryRoot: root, targetsDir: targets }).files,
    )
    const recipe = loadTargetRecipe("app", { targetsDir: targets, repositoryRoot: root })
    const definition = targetWorkspace(
      { id: "measure-app", target: recipe, specText: "measuring\n", defectPatch: null },
      "measure",
      { captureRoot: temp("factory-measure-captures-"), repositoryRoot: root },
    )
    // Every capture entry init proposed is present at the pin and archives.
    expect(definition.source.include).toEqual([
      ".npmrc",
      "package.json",
      "packages/app/package.json",
      "packages/app/src/index.ts",
      "packages/app/test/app.test.ts",
      "packages/app/test/helpers/h.ts",
      "packages/app/tsconfig.build.json",
      "packages/app/tsconfig.json",
      "packages/app/vitest.config.ts",
      "packages/config/base.json",
      "packages/config/package.json",
      "packages/core/package.json",
      "packages/core/src/index.ts",
      "packages/core/tsconfig.json",
      "packages/util/package.json",
      "packages/util/src/index.ts",
      "packages/util/tsconfig.json",
      "pnpm-workspace.yaml",
    ])
    expect(definition.environmentLinks).toEqual([
      { path: "node_modules", target: "/opt/targets/app/node_modules" },
    ])
    expect(targetInspectionOptions({ target: recipe }).ignorePrefixes).toEqual(
      recipe.snapshotIgnore,
    )
  })
})
