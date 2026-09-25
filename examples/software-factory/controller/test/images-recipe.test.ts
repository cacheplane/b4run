import { afterEach, describe, expect, it } from "vitest"
import { imageRecipeDigest } from "../src/lib/domain/digest.ts"
import { type TargetRecipe, tagFor } from "../src/lib/targets/catalog.ts"
import {
  baseDigestOf,
  dockerfileSha256Of,
  hostPlatform,
  imageTag,
  recipeKey,
} from "../src/lib/targets/images.ts"
import { cleanupRecipeFixtures, recipeFixture } from "./recipe-fixture.ts"

afterEach(cleanupRecipeFixtures)

describe("the image recipe key", () => {
  it("is stable for one recipe and platform", () => {
    const recipe = recipeFixture()
    expect(recipeKey(recipe, "linux/arm64")).toMatch(/^[a-f0-9]{64}$/)
    expect(recipeKey(recipe, "linux/arm64")).toBe(recipeKey({ ...recipe }, "linux/arm64"))
  })

  it("changes with every recipe input, including the ones today's tag does not see", () => {
    const recipe = recipeFixture()
    const key = recipeKey(recipe, "linux/arm64")
    const variants: TargetRecipe[] = [
      { ...recipe, pin: "1".repeat(40) },
      { ...recipe, baseImage: `node:24-slim@sha256:${"f".repeat(64)}` },
      { ...recipe, imageContext: [...recipe.imageContext, "packages/sdk/package.json"] },
      { ...recipe, lockfile: "other-lock.yaml" },
      { ...recipe, imageAssertResolves: [...recipe.imageAssertResolves, "zod"] },
      // devkit's own cwd is `packages/devkit`: any other value is another recipe.
      { ...recipe, commands: { ...recipe.commands, cwd: "." } },
      { ...recipe, id: "devkit2" },
      recipeFixture({}, "FROM scratch\nRUN true\n"),
    ]
    for (const variant of variants) expect(recipeKey(variant, "linux/arm64")).not.toBe(key)
    expect(recipeKey(recipe, "linux/amd64")).not.toBe(key)
  })

  it("ignores list order where order does not change the build, and every non-recipe field", () => {
    const recipe = recipeFixture()
    const key = recipeKey(recipe, "linux/arm64")
    expect(
      recipeKey({ ...recipe, imageContext: [...recipe.imageContext].reverse() }, "linux/arm64"),
    ).toBe(key)
    expect(recipeKey({ ...recipe, draftingNotes: ["a note"] }, "linux/arm64")).toBe(key)
    expect(
      recipeKey({ ...recipe, resources: { ...recipe.resources, cpus: 7 } }, "linux/arm64"),
    ).toBe(key)
    expect(recipeKey({ ...recipe, capture: { include: ["x"] } }, "linux/arm64")).toBe(key)
  })

  it("reads the Dockerfile's bytes, the base's digest, and the host's platform", () => {
    const recipe = recipeFixture({}, "FROM scratch\n")
    // sha256 of the 13 bytes `FROM scratch\n` (`printf 'FROM scratch\n' | shasum -a 256`).
    expect(dockerfileSha256Of(recipe)).toBe(
      "bb57c7da220a8753d7bdabac0d3afdb6efa742e4c736c5bc93ab40dfd5e23b9b",
    )
    expect(baseDigestOf(`node:24-slim@sha256:${"e".repeat(64)}`)).toBe(`sha256:${"e".repeat(64)}`)
    expect(hostPlatform("arm64")).toBe("linux/arm64")
    expect(hostPlatform("x64")).toBe("linux/amd64")
    expect(() => hostPlatform("ia32")).toThrow(/Unsupported host architecture ia32/)
  })

  it("tags a loaded target by its recipe key on its image's platform", () => {
    const recipe = recipeFixture()
    const image = {
      localId: `sha256:${"a".repeat(64)}`,
      platform: "linux/amd64",
      baseManifestDigest: baseDigestOf(recipe.baseImage),
      dockerfileSha256: dockerfileSha256Of(recipe),
      lockfileSha256: "d".repeat(64),
      pnpmVersion: "10.33.0",
    }
    expect(imageTag({ ...recipe, image })).toBe(
      tagFor(recipe.id, recipe.pin, recipeKey(recipe, "linux/amd64")),
    )
  })

  it("is the domain-separated digest of its inputs", () => {
    const recipe = recipeFixture()
    expect(recipeKey(recipe, "linux/arm64")).toBe(
      imageRecipeDigest({
        targetId: recipe.id,
        pin: recipe.pin,
        platform: "linux/arm64",
        baseImage: recipe.baseImage,
        dockerfileSha256: dockerfileSha256Of(recipe),
        imageContext: recipe.imageContext,
        lockfile: recipe.lockfile,
        imageAssertResolves: recipe.imageAssertResolves,
        commandsCwd: recipe.commands.cwd,
      }),
    )
  })
})
