import { createHash } from "node:crypto"
import { mkdirSync, readFileSync } from "node:fs"
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

export function openImageRegistry(options: ImageRegistryOptions): ImageRegistry {
  mkdirSync(dirname(options.path), { recursive: true })
  const db = new DatabaseSync(options.path)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec(SCHEMA)
  const found = Number(
    (db.prepare("SELECT max(version) AS v FROM schema_version").get() as { v: number | null }).v ??
      0,
  )
  if (found > IMAGE_REGISTRY_VERSION) {
    db.close()
    throw new Error(
      `The image registry schema version ${found} is newer than this factory supports (${IMAGE_REGISTRY_VERSION}): upgrade the factory, or give it another FACTORY_STATE_DIR`,
    )
  }
  if (found < IMAGE_REGISTRY_VERSION)
    db.prepare("INSERT OR IGNORE INTO schema_version(version) VALUES (?)").run(
      IMAGE_REGISTRY_VERSION,
    )
  const platform = options.platform ?? hostPlatform()
  const now = options.now ?? Date.now

  const describe = (recipe: TargetRecipe): Described => {
    const dockerfileSha256 = dockerfileSha256Of(recipe)
    const key = recipeKey(recipe, platform, dockerfileSha256)
    return { key, tag: tagFor(recipe.id, recipe.pin, key), dockerfileSha256 }
  }
  const read = (key: string): Image | undefined => {
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
      if (image !== undefined) return { key: described.key, tag: described.tag, image }
      ensureOptions.onBuild?.({ key: described.key, shared: false, deadlineMs: 0 })
      const built = await build(described, recipe, signal)
      return {
        key: described.key,
        tag: described.tag,
        image: built.image,
        build: { shared: false, ms: built.ms, log: built.log },
      }
    },
    async present(localId, signal) {
      return (await options.builder.inspect(localId, signal)) !== null
    },
    close() {
      db.close()
    },
  }
}
