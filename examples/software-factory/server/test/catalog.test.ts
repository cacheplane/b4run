import { describe, expect, it } from "vitest"
import {
  fixturesDir,
  loadFixture,
  loadFixtureIds,
  ManifestSchema,
} from "../src/fixtures/catalog.ts"

describe("fixture catalog", () => {
  it("discovers the fixture on disk rather than a compiled-in id", () => {
    expect(loadFixtureIds()).toEqual(["cli-flags"])
  })

  it("loads a validated manifest and checks policy", () => {
    const fixture = loadFixture("cli-flags")
    expect(fixture.id).toBe("cli-flags")
    expect(fixture.manifest.allowedSourcePaths).toEqual(["src/cli.ts"])
    expect(fixture.manifest.immutablePaths).toContain("test/cli.test.ts")
    expect(fixture.checks.visible.assertions.length).toBeGreaterThan(0)
    expect(fixture.checks.independent.assertions.length).toBeGreaterThan(0)
    expect(fixture.taskText).toMatch(/\S/)
    expect(fixture.directory.endsWith("fixtures/cli-flags")).toBe(true)
    expect(fixturesDir.endsWith("fixtures")).toBe(true)
  })

  it("refuses an unknown fixture by name", () => {
    expect(() => loadFixture("nope")).toThrow(/Unknown fixture: nope/)
  })

  it("refuses an allowed path that could hide a check or a test", () => {
    // The schema, not the data, is what protects a future fixture.
    expect(
      ManifestSchema.safeParse({
        id: "x",
        allowedSourcePaths: ["test/cli.test.ts"],
        immutablePaths: [],
      }).success,
    ).toBe(false)
    expect(
      ManifestSchema.safeParse({
        id: "x",
        allowedSourcePaths: ["checks/independent.test.ts"],
        immutablePaths: [],
      }).success,
    ).toBe(false)
    expect(
      ManifestSchema.safeParse({
        id: "x",
        allowedSourcePaths: ["src/cli.ts"],
        immutablePaths: ["src/cli.ts"],
      }).success,
    ).toBe(false)
  })
})
