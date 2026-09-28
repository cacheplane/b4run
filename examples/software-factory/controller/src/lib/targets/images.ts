import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { imageRecipeDigest } from "../domain/digest.js"
import {
  type Image,
  ImageSchema,
  repositoryRoot,
  type Target,
  type TargetRecipe,
  tagFor,
} from "./catalog.js"

/** The Docker platform this host builds and runs: the image object's `platform`. */
export function hostPlatform(arch: string = process.arch): string {
  if (arch === "arm64") return "linux/arm64"
  if (arch === "x64") return "linux/amd64"
  throw new Error(`Unsupported host architecture ${arch}`)
}

/** sha256 of the target's Dockerfile, over its exact bytes. */
export function dockerfileSha256Of(recipe: Pick<TargetRecipe, "directory">): string {
  return createHash("sha256")
    .update(readFileSync(join(recipe.directory, "Dockerfile")))
    .digest("hex")
}

/** `sha256:<hex>` of a `<name>[:<tag>]@sha256:<hex>` reference the schema already checked. */
export function baseDigestOf(baseImage: string): string {
  return baseImage.slice(baseImage.indexOf("@") + 1)
}

/**
 * The recipe tag of a loaded target: its recipe key on its image's platform. Moved here from
 * `catalog.ts` (which cannot import this module at runtime); every importer of `imageTag`
 * now imports it from `targets/images.js`.
 */
export function imageTag(target: Target): string {
  return tagFor(target.id, target.pin, recipeKey(target, target.image.platform))
}

/** The recipe tag `recipe` builds under on `platform` (this host's by default). */
export function recipeTag(recipe: TargetRecipe, platform: string = hostPlatform()): string {
  return tagFor(recipe.id, recipe.pin, recipeKey(recipe, platform))
}

/** The registry key of `recipe` (at its own pin) on `platform`: see `imageRecipeDigest`. */
export function recipeKey(
  recipe: TargetRecipe,
  platform: string,
  dockerfileSha256: string = dockerfileSha256Of(recipe),
): string {
  return imageRecipeDigest({
    targetId: recipe.id,
    pin: recipe.pin,
    platform,
    baseImage: recipe.baseImage,
    dockerfileSha256,
    imageContext: recipe.imageContext,
    lockfile: recipe.lockfile,
    imageAssertResolves: recipe.imageAssertResolves,
    commandsCwd: recipe.commands.cwd,
  })
}

/** What one build is asked for. */
export interface BuildRequest {
  readonly recipe: TargetRecipe
  readonly platform: string
  /** The recipe key: stamped on the image as the `b4.factory.key` label and part of both tags. */
  readonly key: string
  /** The recipe tag (`tagFor`); the builder also stamps the id tag (`idTagFor`) once it knows the id. */
  readonly tag: string
  readonly repositoryRoot: string
}

/**
 * The Docker side of the registry, injectable so the registry's rules (one build per key, the
 * limit, cancellation, drift) are testable without a daemon. `dockerImageBuilder` is the real one.
 */
export interface ImageBuilder {
  /** Build `request`'s image, writing its output to `log`. Rejects when `signal` aborts. */
  build(request: BuildRequest, log: (chunk: string) => void, signal: AbortSignal): Promise<Image>
  /** The daemon's tags for `localId`, or null when the daemon does not hold that image. */
  inspect(
    localId: string,
    signal: AbortSignal,
  ): Promise<{ readonly tags: readonly string[] } | null>
  /** Point `tag` at `localId`. */
  tag(localId: string, tag: string, signal: AbortSignal): Promise<void>
}

export interface RecordedImage {
  readonly key: string
  readonly tag: string
  readonly image: Image
}

export interface EnsuredImage extends RecordedImage {
  /** Present when this call built the image, or waited on a build another call started. */
  readonly build?: { readonly shared: boolean; readonly ms: number; readonly log: string }
}

export interface EnsureOptions {
  readonly signal: AbortSignal
  /**
   * Once, when this call starts a build (`shared: false`) or joins one in flight (`shared: true`).
   * `deadlineMs` is how long this call will wait for it at most (queue and build, D6).
   */
  readonly onBuild?: (event: {
    readonly key: string
    readonly shared: boolean
    readonly deadlineMs: number
  }) => void
  /** When the recorded image is gone from the daemon; it is then forgotten and built again. */
  readonly onMissing?: (event: { readonly key: string; readonly localId: string }) => void
}

/**
 * This host's images, one per recipe (`recipeKey`): `<FACTORY_STATE_DIR>/images.sqlite`. The
 * controller asks it when a work order first needs a target at a pin; `target:prepare` asks it
 * to warm a pin by hand. Nothing here is model-written: a recipe is the reviewed target, the
 * committed Dockerfile and the repository at a pin.
 */
export interface ImageRegistry {
  /** The image recorded for `recipe` at its pin on this platform. A SQLite read: no Docker. */
  recorded(recipe: TargetRecipe): RecordedImage | undefined
  /** The recorded image, or a build of it. See `openImageRegistry`. */
  ensure(recipe: TargetRecipe, options: EnsureOptions): Promise<EnsuredImage>
  /** Does the daemon hold `localId`? What a bound work order asks instead of `ensure` (D5). */
  present(localId: string, signal: AbortSignal): Promise<boolean>
  /** Abort every build in flight and close the database. */
  close(): void
}

/** A build that produced no image. `log` is what it printed, kept as evidence. */
export class ImagePrepareError extends Error {
  constructor(
    message: string,
    readonly key: string,
    readonly log: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "ImagePrepareError"
  }
}

export const IMAGE_REGISTRY_VERSION = 1
export const DEFAULT_MAX_IMAGE_BUILDS = 1
export const DEFAULT_IMAGE_BUILD_TIMEOUT_MS = 30 * 60_000
/** The most of one build's output kept: its tail, which is where a failure explains itself. */
export const BUILD_LOG_LIMIT = 1024 * 1024

export interface ImageRegistryOptions {
  /** `<FACTORY_STATE_DIR>/images.sqlite`. */
  readonly path: string
  readonly builder: ImageBuilder
  /** Builds running at once across every key (`FACTORY_MAX_IMAGE_BUILDS`). */
  readonly maxConcurrentBuilds?: number
  /** Per build, from when it takes its slot (`FACTORY_IMAGE_BUILD_TIMEOUT_MS`). */
  readonly buildTimeoutMs?: number
  /**
   * How long a caller may wait for a slot before its build starts; twice the build timeout
   * when absent. A caller's whole wait is bounded by this plus the build timeout (D6).
   */
  readonly queueTimeoutMs?: number
  /** The repository the build context is archived from; `repositoryRoot()` when absent. */
  readonly repositoryRoot?: string
  /** `hostPlatform()` when absent. */
  readonly platform?: string
  readonly now?: () => number
}

/**
 * Versioned like the work-order registry (`registry/db.ts`): a `schema_version` table, one row
 * per applied version, rather than `PRAGMA user_version`, so the two stores on one state
 * directory read the same way and a person inspecting either finds the version where the other
 * keeps it.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS images (
    key TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    pin TEXT NOT NULL,
    tag TEXT NOT NULL,
    local_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    base_manifest_digest TEXT NOT NULL,
    dockerfile_sha256 TEXT NOT NULL,
    lockfile_sha256 TEXT NOT NULL,
    pnpm_version TEXT NOT NULL,
    built_at TEXT NOT NULL,
    build_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS images_by_target_pin ON images(target_id, pin);
`

interface ImageRow {
  readonly tag: string
  readonly local_id: string
  readonly platform: string
  readonly base_manifest_digest: string
  readonly dockerfile_sha256: string
  readonly lockfile_sha256: string
  readonly pnpm_version: string
}

/** A build's output, bounded to its last `BUILD_LOG_LIMIT` characters, with a note of what was cut. */
export class BuildLog {
  private text_ = ""
  private dropped = 0
  write(chunk: string): void {
    this.text_ += chunk
    if (this.text_.length > 2 * BUILD_LOG_LIMIT) {
      const cut = this.text_.length - BUILD_LOG_LIMIT
      this.text_ = this.text_.slice(cut)
      this.dropped += cut
    }
  }
  text(): string {
    const cut = Math.max(0, this.text_.length - BUILD_LOG_LIMIT)
    const tail = this.text_.slice(cut)
    const dropped = this.dropped + cut
    return dropped > 0 ? `[${dropped} earlier characters of the build log dropped]\n${tail}` : tail
  }
}

/** Why `image` is not what `recipe` builds on `platform`, or undefined when it is. */
function recipeMismatch(
  image: Image,
  recipe: TargetRecipe,
  platform: string,
  dockerfileSha256: string,
): string | undefined {
  if (image.platform !== platform) return `platform ${image.platform}, not ${platform}`
  if (image.dockerfileSha256 !== dockerfileSha256) return "another Dockerfile"
  const base = baseDigestOf(recipe.baseImage)
  if (image.baseManifestDigest !== base) return `base ${image.baseManifestDigest}, not ${base}`
  return undefined
}

interface Described {
  readonly key: string
  readonly tag: string
  readonly dockerfileSha256: string
}
interface Built {
  readonly image: Image
  readonly ms: number
  readonly log: string
}

/** A counting semaphore whose waiters leave the queue when their signal aborts. */
export class BuildSlots {
  private free: number
  private readonly queue: (() => void)[] = []
  constructor(size: number) {
    if (!Number.isInteger(size) || size < 1)
      throw new Error(`the image build limit must be a positive integer, got ${size}`)
    this.free = size
  }
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.free > 0) {
      this.free -= 1
      return this.releaser()
    }
    return await new Promise<() => void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort)
        resolve(this.releaser())
      }
      const onAbort = () => {
        const at = this.queue.indexOf(grant)
        if (at >= 0) this.queue.splice(at, 1)
        reject(signal.reason)
      }
      this.queue.push(grant)
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }
  private releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.queue.shift()
      if (next) next()
      else this.free += 1
    }
  }
}

/** `promise`, or `signal`'s reason as soon as it aborts; the promise itself runs on. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

interface Flight {
  readonly promise: Promise<Built>
  readonly controller: AbortController
  waiters: number
  settled: boolean
}

/** The recorded image under `key`, or undefined: the one read both the registry and its reader do. */
function readRecorded(db: DatabaseSync, key: string): Image | undefined {
  const row = db
    .prepare(
      "SELECT tag, local_id, platform, base_manifest_digest, dockerfile_sha256, lockfile_sha256, pnpm_version FROM images WHERE key = ?",
    )
    .get(key) as unknown as ImageRow | undefined
  if (row === undefined) return undefined
  return ImageSchema.parse({
    localId: row.local_id,
    platform: row.platform,
    baseManifestDigest: row.base_manifest_digest,
    dockerfileSha256: row.dockerfile_sha256,
    lockfileSha256: row.lockfile_sha256,
    pnpmVersion: row.pnpm_version,
  })
}

/**
 * The schema version `db` records (0 when it has no `schema_version` table), refusing, and
 * closing `db`, when a newer factory wrote it.
 */
function checkedSchemaVersion(db: DatabaseSync): number {
  const versioned =
    db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("schema_version") !== undefined
  const found = versioned
    ? Number(
        (db.prepare("SELECT max(version) AS v FROM schema_version").get() as { v: number | null })
          .v ?? 0,
      )
    : 0
  if (found > IMAGE_REGISTRY_VERSION) {
    db.close()
    throw new Error(
      `The image registry schema version ${found} is newer than this factory supports (${IMAGE_REGISTRY_VERSION}): upgrade the factory, or give it another FACTORY_STATE_DIR`,
    )
  }
  return found
}

/** The read-only registry `openImageRegistryReader` opens: `recorded`, and nothing that writes. */
export interface ImageRegistryReader {
  /** What the registry records for `recipe` at its own pin on the reader's platform, if anything. */
  recorded(recipe: TargetRecipe): RecordedImage | undefined
  close(): void
}

/**
 * The registry, read-only: what a command that must not create, migrate or write a host's
 * registry opens (`factory builder-handoff`). It creates no registry and writes nothing to it;
 * SQLite may leave `-wal`/`-shm` files beside a quiescent WAL registry, which is SQLite's own
 * bookkeeping, not a write to the registry. Refuses a path with no registry, one written by a
 * newer factory, and one no factory has finished creating (no schema version), which it leaves
 * as it found it.
 */
export function openImageRegistryReader(
  path: string,
  platform: string = hostPlatform(),
): ImageRegistryReader {
  if (!existsSync(path)) throw new Error(`no image registry at ${path}`)
  const db = new DatabaseSync(path, { readOnly: true })
  let found: number
  try {
    db.exec("PRAGMA busy_timeout = 5000")
    found = checkedSchemaVersion(db)
  } catch (error) {
    if (db.isOpen) db.close()
    throw error
  }
  if (found < IMAGE_REGISTRY_VERSION) {
    db.close()
    throw new Error(`no image registry at ${path}: it records no schema version`)
  }
  return {
    recorded(recipe) {
      const key = recipeKey(recipe, platform)
      const image = readRecorded(db, key)
      return image === undefined
        ? undefined
        : { key, tag: tagFor(recipe.id, recipe.pin, key), image }
    },
    close: () => db.close(),
  }
}

export function openImageRegistry(options: ImageRegistryOptions): ImageRegistry {
  mkdirSync(dirname(options.path), { recursive: true })
  const db = new DatabaseSync(options.path)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  // The version first: a registry a newer factory wrote is refused before this one creates
  // its own tables or indexes in it.
  const found = checkedSchemaVersion(db)
  db.exec(SCHEMA)
  if (found < IMAGE_REGISTRY_VERSION)
    db.prepare("INSERT OR IGNORE INTO schema_version(version) VALUES (?)").run(
      IMAGE_REGISTRY_VERSION,
    )
  const platform = options.platform ?? hostPlatform()
  const now = options.now ?? Date.now
  const slots = new BuildSlots(options.maxConcurrentBuilds ?? DEFAULT_MAX_IMAGE_BUILDS)
  const timeoutMs = options.buildTimeoutMs ?? DEFAULT_IMAGE_BUILD_TIMEOUT_MS
  /** A caller's whole wait: a slot, then the build. Journalled, so a follower knows the bound. */
  const waitBoundMs = (options.queueTimeoutMs ?? 2 * timeoutMs) + timeoutMs
  /** The build in flight per key. A later caller joins it rather than building again. */
  const inflight = new Map<string, Flight>()

  const describe = (recipe: TargetRecipe): Described => {
    const dockerfileSha256 = dockerfileSha256Of(recipe)
    const key = recipeKey(recipe, platform, dockerfileSha256)
    return { key, tag: tagFor(recipe.id, recipe.pin, key), dockerfileSha256 }
  }
  const read = (key: string): Image | undefined => readRecorded(db, key)
  const write = (described: Described, recipe: TargetRecipe, image: Image, ms: number) => {
    db.prepare(
      `INSERT OR REPLACE INTO images (key, target_id, pin, tag, local_id, platform, base_manifest_digest, dockerfile_sha256, lockfile_sha256, pnpm_version, built_at, build_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      described.key,
      recipe.id,
      recipe.pin,
      described.tag,
      image.localId,
      image.platform,
      image.baseManifestDigest,
      image.dockerfileSha256,
      image.lockfileSha256,
      image.pnpmVersion,
      new Date(now()).toISOString(),
      ms,
    )
  }

  /** Drop `key`'s record, but only if it still names `localId`: another writer may have replaced it. */
  const forget = (key: string, localId: string) => {
    db.prepare("DELETE FROM images WHERE key = ? AND local_id = ?").run(key, localId)
  }

  /** One build, start to record. A failure of any kind is an `ImagePrepareError` with the log. */
  async function build(
    described: Described,
    recipe: TargetRecipe,
    signal: AbortSignal,
  ): Promise<Built> {
    const log = new BuildLog()
    const started = now()
    const fail = (reason: string, cause?: unknown): never => {
      throw new ImagePrepareError(
        `Target ${recipe.id} at ${recipe.pin}: ${reason}`,
        described.key,
        log.text(),
        cause === undefined ? undefined : { cause },
      )
    }
    let image: Image
    try {
      image = await options.builder.build(
        {
          recipe,
          platform,
          key: described.key,
          tag: described.tag,
          repositoryRoot: options.repositoryRoot ?? repositoryRoot(),
        },
        (chunk) => log.write(chunk),
        signal,
      )
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), error)
    }
    const mismatch = recipeMismatch(image, recipe, platform, described.dockerfileSha256)
    if (mismatch !== undefined)
      fail(`the builder reported an image of another recipe (${mismatch})`)
    const ms = now() - started
    write(described, recipe, image, ms)
    return { image, ms, log: log.text() }
  }

  /**
   * Start `described`'s build: queued for a slot, then bounded by the timeout from when it
   * runs. Its controller aborts only when the last waiter leaves (`ensure`) or the registry
   * closes, so one work order's cancel never kills a build another still waits on.
   */
  function startFlight(described: Described, recipe: TargetRecipe): Flight {
    const controller = new AbortController()
    const run = async (): Promise<Built> => {
      let release: () => void
      try {
        release = await slots.acquire(controller.signal)
      } catch (error) {
        throw new ImagePrepareError(
          `Target ${recipe.id} at ${recipe.pin}: the build was abandoned before it started`,
          described.key,
          "",
          { cause: error },
        )
      }
      try {
        const deadline = AbortSignal.timeout(timeoutMs)
        try {
          return await build(described, recipe, AbortSignal.any([controller.signal, deadline]))
        } catch (error) {
          if (deadline.aborted && !controller.signal.aborted && error instanceof ImagePrepareError)
            throw new ImagePrepareError(
              `Target ${recipe.id} at ${recipe.pin}: the build exceeded ${timeoutMs} ms (FACTORY_IMAGE_BUILD_TIMEOUT_MS)`,
              described.key,
              error.log,
              { cause: error },
            )
          throw error
        }
      } finally {
        release()
      }
    }
    const flight: Flight = {
      controller,
      waiters: 0,
      settled: false,
      promise: run().finally(() => {
        flight.settled = true
        if (inflight.get(described.key) === flight) inflight.delete(described.key)
      }),
    }
    // Every waiter may have left: the rejection is then nobody's, and must not be unhandled.
    flight.promise.catch(() => {})
    inflight.set(described.key, flight)
    return flight
  }

  return {
    recorded(recipe) {
      const described = describe(recipe)
      const image = read(described.key)
      return image === undefined ? undefined : { key: described.key, tag: described.tag, image }
    },
    async ensure(recipe, ensureOptions) {
      const { signal } = ensureOptions
      signal.throwIfAborted()
      const described = describe(recipe)
      const image = read(described.key)
      if (image !== undefined) {
        // Re-verified on every need: an image pruned or removed since it was recorded is not
        // this key's answer any more, and a tag another image took is pointed back so a
        // dangling-image prune cannot remove the recorded one.
        const found = await options.builder.inspect(image.localId, signal)
        if (found !== null) {
          if (!found.tags.includes(described.tag))
            await options.builder.tag(image.localId, described.tag, signal)
          return { key: described.key, tag: described.tag, image }
        }
        ensureOptions.onMissing?.({ key: described.key, localId: image.localId })
        forget(described.key, image.localId)
      }
      const joined = inflight.get(described.key)
      const flight = joined ?? startFlight(described, recipe)
      const shared = joined !== undefined
      // Counted before `onBuild` runs, inside the `try` whose `finally` uncounts it: a caller
      // whose hook throws leaves the build as a cancel would, never waiterless and running.
      flight.waiters += 1
      // This caller's own bound: queued behind other keys' builds, then this build. Leaving at
      // it is leaving like a cancel: the build goes on only if another caller still waits.
      const waited = AbortSignal.timeout(waitBoundMs)
      try {
        ensureOptions.onBuild?.({ key: described.key, shared, deadlineMs: waitBoundMs })
        const built = await abortable(flight.promise, AbortSignal.any([signal, waited])).catch(
          (error: unknown) => {
            if (waited.aborted && !signal.aborted)
              throw new ImagePrepareError(
                `Target ${recipe.id} at ${recipe.pin}: waited more than ${waitBoundMs} ms for the image (queued behind other builds, then built); FACTORY_MAX_IMAGE_BUILDS and FACTORY_IMAGE_BUILD_TIMEOUT_MS bound this`,
                described.key,
                "",
                { cause: error },
              )
            throw error
          },
        )
        return {
          key: described.key,
          tag: described.tag,
          image: built.image,
          build: { shared, ms: built.ms, log: built.log },
        }
      } finally {
        flight.waiters -= 1
        if (flight.waiters === 0 && !flight.settled) {
          // Nobody waits on it any more: a later need starts afresh rather than joining a
          // build that is being cancelled.
          if (inflight.get(described.key) === flight) inflight.delete(described.key)
          flight.controller.abort(new Error("no work order is waiting on this image build"))
        }
      }
    },
    async present(localId, signal) {
      return (await options.builder.inspect(localId, signal)) !== null
    },
    close() {
      for (const flight of inflight.values())
        flight.controller.abort(new Error("the image registry closed"))
      inflight.clear()
      db.close()
    },
  }
}
