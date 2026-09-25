import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as sleep } from "node:timers/promises"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { tagFor } from "../src/lib/targets/catalog.ts"
import {
  type EnsureOptions,
  type ImageBuilder,
  ImagePrepareError,
  type ImageRegistry,
  type ImageRegistryOptions,
  openImageRegistry,
  openImageRegistryReader,
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
    // Refused before this factory wrote its own tables into the newer registry.
    const after = new DatabaseSync(join(dir, "images.sqlite"))
    const tables = after
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name)
    after.close()
    expect(tables).toEqual(["schema_version"])
    expect(() => openImageRegistryReader(join(dir, "images.sqlite"))).toThrow(
      /image registry schema version 99 is newer than this factory supports \(1\)/,
    )
  })

  it("refuses a file no factory finished creating, and leaves it as it found it", () => {
    const path = join(dir, "images.sqlite")
    new DatabaseSync(path).close()
    expect(() => openImageRegistryReader(path)).toThrow(/records no schema version/)
    // Never migrated: the reader created no table or index in it.
    const after = new DatabaseSync(path)
    const objects = after.prepare("SELECT name FROM sqlite_master").all()
    after.close()
    expect(objects).toEqual([])
  })

  it("creates no registry and writes nothing to it; SQLite may leave -wal/-shm beside a quiescent WAL registry", async () => {
    const builder = fakeImageBuilder()
    const recipe = recipeFixture()
    expect(() => openImageRegistryReader(join(dir, "absent.sqlite"))).toThrow(
      /no image registry at/,
    )
    expect(existsSync(join(dir, "absent.sqlite"))).toBe(false)
    const ensured = await ensure(open(builder), recipe)
    const reader = openImageRegistryReader(join(dir, "images.sqlite"), "linux/arm64")
    try {
      expect(reader.recorded(recipe)).toEqual({
        key: ensured.key,
        tag: ensured.tag,
        image: ensured.image,
      })
      expect(reader.recorded({ ...recipe, pin: "f".repeat(40) })).toBeUndefined()
    } finally {
      reader.close()
    }
    // The registry's contents are what the writer left: the reader wrote nothing to it.
    expect(open(builder).recorded(recipe)).toEqual({
      key: ensured.key,
      tag: ensured.tag,
      image: ensured.image,
    })
  })
})

/** Wait until `condition` holds, polling; a test's own bound on a background build. */
async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error("condition never held")
    await sleep(5)
  }
}

describe("builds in flight", () => {
  it("builds a key once however many need it at once", async () => {
    const builder = fakeImageBuilder()
    builder.hold()
    const registry = open(builder)
    const recipe = recipeFixture()
    const events: { key: string; shared: boolean }[] = []
    const onBuild = (event: { key: string; shared: boolean }) => events.push(event)
    const first = ensure(registry, recipe, { onBuild })
    await until(() => builder.requests.length === 1)
    const second = ensure(registry, recipe, { onBuild })
    await until(() => events.length === 2)
    builder.release()
    const [a, b] = await Promise.all([first, second])
    expect(builder.requests).toHaveLength(1)
    expect(a.image).toEqual(b.image)
    expect(events.map((e) => e.shared)).toEqual([false, true])
    expect([a.build?.shared, b.build?.shared]).toEqual([false, true])
  })

  it("never runs more builds at once than its limit, and queues the rest", async () => {
    for (const limit of [1, 2]) {
      const builder = fakeImageBuilder()
      builder.hold()
      const registry = open(builder, {
        maxConcurrentBuilds: limit,
        path: join(dir, `limit-${limit}.sqlite`),
      })
      const recipes = [0, 1, 2].map((n) => recipeFixture({ pin: String(n).repeat(40) }))
      const all = Promise.all(recipes.map((recipe) => ensure(registry, recipe)))
      await until(() => builder.running === limit)
      await sleep(50)
      expect(builder.running).toBe(limit)
      builder.release()
      await all
      expect(builder.maxRunning).toBe(limit)
      expect(builder.requests).toHaveLength(3)
    }
  })

  it("keeps a shared build running when one waiter leaves, and cancels it when the last does", async () => {
    const builder = fakeImageBuilder()
    builder.hold()
    const registry = open(builder)
    const recipe = recipeFixture()
    const leaving = new AbortController()
    const staying = ensure(registry, recipe)
    const left = registry
      .ensure(recipe, { signal: leaving.signal })
      .catch((error: unknown) => error)
    await until(() => builder.requests.length === 1)
    leaving.abort(new Error("work order cancelled"))
    expect(await left).toEqual(new Error("work order cancelled"))
    expect(builder.aborted).toBe(0)
    builder.release()
    expect((await staying).image.localId).toMatch(/^sha256:/)

    const alone = new AbortController()
    builder.hold()
    const other = recipeFixture({ pin: "2".repeat(40) })
    const cancelled = registry
      .ensure(other, { signal: alone.signal })
      .catch((error: unknown) => error)
    await until(() => builder.requests.length === 2)
    alone.abort(new Error("work order cancelled"))
    await cancelled
    await until(() => builder.aborted === 1)
    expect(registry.recorded(other)).toBeUndefined()
    // A cancelled build left nothing behind: the next need builds afresh.
    builder.release()
    await ensure(registry, other)
    expect(builder.requests).toHaveLength(3)
  })

  it("cancels a build whose only caller's onBuild threw, rather than leave it waiterless", async () => {
    const builder = fakeImageBuilder()
    builder.hold()
    const registry = open(builder)
    const recipe = recipeFixture()
    await expect(
      ensure(registry, recipe, {
        onBuild: () => {
          throw new Error("journal write failed")
        },
      }),
    ).rejects.toThrow("journal write failed")
    // The abandoned build was cancelled, so the next need starts its own instead of joining it.
    builder.release()
    const next = await ensure(registry, recipe)
    expect(next.build?.shared).toBe(false)
    await until(() => builder.running === 0)
  })

  it("leaves a queued waiter's cancel costing nothing", async () => {
    const builder = fakeImageBuilder()
    builder.hold()
    const registry = open(builder, { maxConcurrentBuilds: 1 })
    const running = ensure(registry, recipeFixture({ pin: "3".repeat(40) }))
    await until(() => builder.running === 1)
    const queued = new AbortController()
    const waiting = registry
      .ensure(recipeFixture({ pin: "4".repeat(40) }), { signal: queued.signal })
      .catch((error: unknown) => error)
    queued.abort(new Error("gone"))
    expect(await waiting).toEqual(new Error("gone"))
    builder.release()
    await running
    expect(builder.requests).toHaveLength(1)
  })

  it("bounds a caller's whole wait, queue included, and says what it waited on", async () => {
    const builder = fakeImageBuilder()
    builder.hold()
    const registry = open(builder, {
      maxConcurrentBuilds: 1,
      buildTimeoutMs: 5_000,
      queueTimeoutMs: 100,
    })
    const ahead = ensure(registry, recipeFixture({ pin: "5".repeat(40) })).catch((e: unknown) => e)
    await until(() => builder.running === 1)
    const behind = recipeFixture({ pin: "6".repeat(40) })
    const started: number[] = []
    const failure = await ensure(registry, behind, {
      onBuild: ({ deadlineMs }) => started.push(deadlineMs),
    }).catch((error: unknown) => error)
    expect(started).toEqual([5_100])
    expect(failure).toBeInstanceOf(ImagePrepareError)
    expect((failure as ImagePrepareError).message).toBe(
      `Target devkit at ${behind.pin}: waited more than 5100 ms for the image (queued behind other builds, then built); FACTORY_MAX_IMAGE_BUILDS and FACTORY_IMAGE_BUILD_TIMEOUT_MS bound this`,
    )
    // Nothing was recorded for it: the next need starts afresh. (The build ahead timed out at
    // 5,000 ms and freed the slot, so the queued build may have started before its only
    // waiter left and cancelled it; either way it recorded nothing.)
    expect(registry.recorded(behind)).toBeUndefined()
    builder.release()
    await ahead
  }, 15_000)

  it("fails a build past its timeout, naming the limit, with the log so far", async () => {
    const builder = fakeImageBuilder()
    builder.hold()
    const registry = open(builder, { buildTimeoutMs: 50 })
    const recipe = recipeFixture()
    const failure = await ensure(registry, recipe).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ImagePrepareError)
    expect((failure as ImagePrepareError).message).toBe(
      `Target devkit at ${recipe.pin}: the build exceeded 50 ms (FACTORY_IMAGE_BUILD_TIMEOUT_MS)`,
    )
    expect((failure as ImagePrepareError).log).toContain("building b4-factory-devkit:")
    expect(builder.aborted).toBe(1)
    expect(registry.recorded(recipe)).toBeUndefined()
    builder.release()
  })

  it("aborts its builds when it closes", async () => {
    const builder = fakeImageBuilder()
    builder.hold()
    const registry = open(builder)
    const pending = ensure(registry, recipeFixture()).catch((error: unknown) => error)
    await until(() => builder.running === 1)
    registry.close()
    registries.splice(registries.indexOf(registry), 1)
    expect(await pending).toBeInstanceOf(Error)
    await until(() => builder.aborted === 1)
  })
})

describe("a registry that disagrees with the daemon", () => {
  it("rebuilds an image the daemon no longer holds, and says so", async () => {
    const builder = fakeImageBuilder()
    const registry = open(builder)
    const recipe = recipeFixture()
    const first = await ensure(registry, recipe)
    builder.daemon.delete(first.image.localId)
    const missing: unknown[] = []
    const second = await ensure(registry, recipe, { onMissing: (event) => missing.push(event) })
    expect(missing).toEqual([{ key: first.key, localId: first.image.localId }])
    expect(builder.requests).toHaveLength(2)
    expect(second.build?.shared).toBe(false)
    expect(second.image.localId).not.toBe(first.image.localId)
    expect(registry.recorded(recipe)?.image.localId).toBe(second.image.localId)
  })

  it("points a moved tag back at the recorded image without rebuilding it", async () => {
    const builder = fakeImageBuilder()
    const registry = open(builder)
    const recipe = recipeFixture()
    const first = await ensure(registry, recipe)
    // Someone tagged another image with the factory's tag.
    builder.daemon.set(`sha256:${"9".repeat(64)}`, [])
    await builder.tag(`sha256:${"9".repeat(64)}`, first.tag, AbortSignal.timeout(1_000))
    expect(builder.daemon.get(first.image.localId)).toEqual([])
    const again = await ensure(registry, recipe)
    expect(again).toEqual({ key: first.key, tag: first.tag, image: first.image })
    expect(builder.requests).toHaveLength(1)
    expect(builder.daemon.get(first.image.localId)).toEqual([first.tag])
  })

  it("answers whether the daemon holds an image, by id", async () => {
    const builder = fakeImageBuilder()
    const registry = open(builder)
    const first = await ensure(registry, recipeFixture())
    const signal = AbortSignal.timeout(1_000)
    expect(await registry.present(first.image.localId, signal)).toBe(true)
    builder.daemon.delete(first.image.localId)
    expect(await registry.present(first.image.localId, signal)).toBe(false)
  })

  it("answers `recorded` from the registry alone, never the daemon", async () => {
    const builder = fakeImageBuilder()
    const registry = open(builder)
    const recipe = recipeFixture()
    const first = await ensure(registry, recipe)
    builder.daemon.clear()
    expect(registry.recorded(recipe)?.image).toEqual(first.image)
  })
})
