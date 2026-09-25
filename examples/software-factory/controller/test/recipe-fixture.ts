import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type TargetRecipe, TargetSchema, targetsDir } from "../src/lib/targets/catalog.ts"

const dirs: string[] = []
/** Remove every directory `recipeFixture` made; an `afterEach`. */
export function cleanupRecipeFixtures(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/**
 * The shipped devkit recipe at its default pin, with `overrides`, and its Dockerfile (`dockerfile`)
 * in a directory of the test's own: a recipe a registry can key and a fake builder can
 * "build" with no git and no Docker.
 */
export function recipeFixture(
  overrides: Partial<TargetRecipe> = {},
  dockerfile = "FROM scratch\n",
): TargetRecipe {
  const directory = mkdtempSync(join(tmpdir(), "factory-recipe-"))
  dirs.push(directory)
  writeFileSync(join(directory, "Dockerfile"), dockerfile)
  const parsed = TargetSchema.parse(
    JSON.parse(readFileSync(join(targetsDir, "devkit", "target.json"), "utf8")),
  ) as Record<string, unknown>
  // Task 7 removes `images` from the schema; until then the shipped manifest still carries it.
  const { images: _images, ...shipped } = parsed
  return { ...(shipped as Omit<TargetRecipe, "directory">), directory, ...overrides }
}
