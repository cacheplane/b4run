import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  parseManifest,
  selectFixture,
  validateDependencies,
  validateProject,
} from "../src/fixtures/catalog.ts"

const valid = {
  id: "cli-flags",
  version: 1,
  sourcePr: "https://github.com/cacheplane/b4run/pull/399",
  sourceCommit: "7088072b6181e7da8b84faba35a623e444f40c94",
  extractionNotes: "Real Commander registration; reduced handler.",
  allowedSourcePaths: ["src/cli.ts"],
  immutablePaths: ["package.json", "package-lock.json", "test/cli.test.ts"],
  command: ["npm", "test"],
  failurePattern: "unknown option",
}

describe("fixture authority", () => {
  it("accepts a pinned historical fixture", () => expect(parseManifest(valid)).toEqual(valid))
  it.each([
    { sourceCommit: "main" },
    { id: "unknown" },
    { extractionNotes: "" },
    { allowedSourcePaths: ["../escape.ts"] },
    { allowedSourcePaths: ["/tmp/x"] },
    { allowedSourcePaths: ["src/../test/x.ts"] },
    { allowedSourcePaths: ["src\\x.ts"] },
    { allowedSourcePaths: ["test/x.ts"] },
    { allowedSourcePaths: ["src/example.test.ts"] },
    { allowedSourcePaths: ["src/config.json"] },
    { allowedSourcePaths: ["package.json"] },
    { allowedSourcePaths: ["src/x.ts", "src/x.ts"] },
    { immutablePaths: ["src/cli.ts"] },
    { command: ["sh", "-c", "npm test"] },
  ])("rejects an invalid manifest: %j", (override) => {
    expect(() => parseManifest({ ...valid, ...override })).toThrow()
  })
  it("rejects an unknown requested fixture", () => {
    expect(() => selectFixture("../cli-flags")).toThrow()
  })
  it("requires exact dependencies matching the lockfile", () => {
    const pkg = { dependencies: { commander: "15.0.0" } }
    const lock = { packages: { "": pkg } }
    expect(() => validateDependencies(pkg, lock)).not.toThrow()
    expect(() => validateDependencies({ dependencies: { commander: "^15.0.0" } }, lock)).toThrow()
    expect(() =>
      validateDependencies(pkg, { packages: { "": { dependencies: { commander: "14.0.0" } } } }),
    ).toThrow()
    expect(() => validateDependencies(pkg, {})).toThrow()
  })
})

it("requires a complete inventory of regular fixture files", async () => {
  const root = await mkdtemp(join(tmpdir(), "b4-catalog-test-"))
  const manifest = parseManifest({ ...valid, immutablePaths: ["package.json"] })
  try {
    await mkdir(join(root, "src"))
    await writeFile(join(root, "package.json"), "{}")
    await expect(validateProject(root, manifest)).rejects.toThrow()
    await mkdir(join(root, "src/cli.ts"))
    await expect(validateProject(root, manifest)).rejects.toThrow()
    await rm(join(root, "src/cli.ts"), { recursive: true })
    await symlink(join(root, "package.json"), join(root, "src/cli.ts"))
    await expect(validateProject(root, manifest)).rejects.toThrow()
    await rm(join(root, "src/cli.ts"))
    await writeFile(join(root, "src/cli.ts"), "export {}")
    await expect(validateProject(root, manifest)).resolves.toEqual(["package.json", "src/cli.ts"])
    await writeFile(join(root, "solution.patch"), "not agent input")
    await expect(validateProject(root, manifest)).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
