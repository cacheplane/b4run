import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { tagFor } from "../src/lib/targets/catalog.ts"
import {
  type EnsureOptions,
  type ImageBuilder,
  ImagePrepareError,
  type ImageRegistry,
  type ImageRegistryOptions,
  openImageRegistry,
  recipeKey,
} from "../src/lib/targets/images.ts"
import { fakeImageBuilder } from "./fake-image-builder.ts"
import { cleanupRecipeFixtures, recipeFixture } from "./recipe-fixture.ts"

let dir: string
const registries: ImageRegistry[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "factory-images-"))
})
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close()
  rmSync(dir, { recursive: true, force: true })
  cleanupRecipeFixtures()
})

function open(builder: ImageBuilder, extra: Partial<ImageRegistryOptions> = {}): ImageRegistry {
  const registry = openImageRegistry({
    path: join(dir, "images.sqlite"),
    builder,
    platform: "linux/arm64",
    repositoryRoot: "/repo",
    ...extra,
  })
  registries.push(registry)
  return registry
}
const ensure = (
  registry: ImageRegistry,
  recipe: ReturnType<typeof recipeFixture>,
  extra: Partial<EnsureOptions> = {},
) => registry.ensure(recipe, { signal: AbortSignal.timeout(10_000), ...extra })

describe("the image registry", () => {
  it("builds on first need, records the image, and answers the next need from the record", async () => {
    const builder = fakeImageBuilder()
    const registry = open(builder)
    const recipe = recipeFixture()
    expect(registry.recorded(recipe)).toBeUndefined()
    const started: unknown[] = []
    const first = await ensure(registry, recipe, { onBuild: (event) => started.push(event) })
    const key = recipeKey(recipe, "linux/arm64")
    const tag = tagFor(recipe.id, recipe.pin, key)
    expect(builder.requests).toHaveLength(1)
    expect(builder.requests[0]).toMatchObject({
      platform: "linux/arm64",
      tag,
      key,
      repositoryRoot: "/repo",
    })
    expect(first.key).toBe(recipeKey(recipe, "linux/arm64"))
    expect(first.tag).toBe(tag)
    expect(first.build?.shared).toBe(false)
    expect(first.build?.log).toContain(`building ${tag}`)
    expect(started).toEqual([{ key: first.key, shared: false, deadlineMs: expect.any(Number) }])

    const second = await ensure(registry, recipe)
    expect(builder.requests).toHaveLength(1)
    expect(second).toEqual({ key: first.key, tag, image: first.image })

    // On disk: a second connection (the next controller, or the script) reads it back.
    expect(open(builder).recorded(recipe)).toEqual({ key: first.key, tag, image: first.image })
  })

  it("keeps one image per recipe: another pin or another Dockerfile is another build", async () => {
    const builder = fakeImageBuilder()
    const registry = open(builder)
    const a = recipeFixture()
    const b = recipeFixture({ pin: "1".repeat(40) })
    const c = recipeFixture({}, "FROM scratch\nRUN true\n")
    const images = [await ensure(registry, a), await ensure(registry, b), await ensure(registry, c)]
    expect(builder.requests).toHaveLength(3)
    expect(new Set(images.map((i) => i.image.localId)).size).toBe(3)
    for (const [recipe, ensured] of [
      [a, images[0]],
      [b, images[1]],
      [c, images[2]],
    ] as const)
      expect(registry.recorded(recipe)?.image).toEqual(ensured?.image)
  })

  it("records nothing for a failed build, carries its log, and builds again on the next need", async () => {
    const builder = fakeImageBuilder()
    const registry = open(builder)
    const recipe = recipeFixture()
    builder.failNext("pnpm install failed", "ERR_PNPM_OUTDATED_LOCKFILE\n")
    const failure = await ensure(registry, recipe).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ImagePrepareError)
    const error = failure as ImagePrepareError
    expect(error.message).toBe(`Target devkit at ${recipe.pin}: pnpm install failed`)
    expect(error.key).toBe(recipeKey(recipe, "linux/arm64"))
    expect(error.log).toContain("ERR_PNPM_OUTDATED_LOCKFILE")
    expect(registry.recorded(recipe)).toBeUndefined()
    await ensure(registry, recipe)
    expect(builder.requests).toHaveLength(2)
    expect(registry.recorded(recipe)).toBeDefined()
  })

  it("refuses an image the builder reports for another recipe", async () => {
    const builder = fakeImageBuilder()
    const lying: ImageBuilder = {
      inspect: builder.inspect,
      tag: builder.tag,
      async build(request, log, signal) {
        return { ...(await builder.build(request, log, signal)), platform: "linux/amd64" }
      },
    }
    const recipe = recipeFixture()
    const registry = open(lying)
    await expect(ensure(registry, recipe)).rejects.toThrow(
      /the builder reported an image of another recipe \(platform linux\/amd64, not linux\/arm64\)/,
    )
    expect(registry.recorded(recipe)).toBeUndefined()
  })

  it("refuses a registry written by a newer factory", () => {
    const db = new DatabaseSync(join(dir, "images.sqlite"))
    db.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY); INSERT INTO schema_version(version) VALUES (99)",
    )
    db.close()
    expect(() => open(fakeImageBuilder())).toThrow(
      /image registry schema version 99 is newer than this factory supports \(1\)/,
    )
  })
})
