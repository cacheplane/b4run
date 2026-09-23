import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { environmentIdentityDigest, type ImageInputs } from "../domain/digest.js"

/** The package root, derived from this module rather than the working directory. */
export const appRoot = fileURLToPath(new URL("../../../", import.meta.url))
/**
 * The target catalog: `targets/` under the app, unless `FACTORY_TARGETS_DIR` names another
 * directory. The override exists so a lane can prepare a COPY of a target (the prepare
 * script writes the manifest it reads) without ever writing the working tree; it is read
 * once, at module load.
 */
export const targetsDir = process.env.FACTORY_TARGETS_DIR || join(appRoot, "targets")
export const tasksDir = join(appRoot, "tasks")

const HEX_64 = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const SHA_256_REF = /^sha256:[a-f0-9]{64}$/

/** Every `/`-separated segment is non-empty and neither `.` nor `..`. */
function hasCanonicalSegments(segments: readonly string[]): boolean {
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
}

/**
 * A relative, forward-slash path with one spelling: no leading slash, no trailing slash,
 * no `.`/`..`/empty segment, and no backslash. Downstream code compares paths by string
 * equality, so two spellings of the same path would silently fail that comparison.
 */
export const relativePath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.endsWith("/") &&
      !p.includes("\\") &&
      hasCanonicalSegments(p.split("/")),
    { message: "must be a relative forward-slash path with one spelling, no trailing slash" },
  )

/**
 * A directory prefix; the trailing slash is required so `dist/` cannot also match
 * `dist-notes.ts`.
 */
const pathPrefix = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      p.endsWith("/") &&
      !p.includes("\\") &&
      hasCanonicalSegments(p.slice(0, -1).split("/")),
    { message: "must be a relative forward-slash directory prefix ending in `/`" },
  )

/**
 * Does one of `entries` cover `path`? An entry is a file or a directory; a directory covers
 * everything under it. Paths are canonical (see `relativePath`), so string comparison is exact.
 */
export function covers(entries: readonly string[], path: string): boolean {
  return entries.some((entry) => path === entry || path.startsWith(`${entry}/`))
}

/**
 * Do `a` and `b` overlap, in either direction? One may be a directory that contains the
 * other, or they may be the same path. Coverage alone (`covers`) only asks whether a whole
 * *list* protects one path; this asks about a single pair, so an allowed directory that
 * happens to contain a single immutable file is caught too, not just the reverse.
 */
export function overlaps(a: string, b: string): boolean {
  return covers([a], b) || covers([b], a)
}

export const ImageSchema = z
  .object({
    localId: z.string().regex(SHA_256_REF),
    platform: z.string().min(1),
    baseManifestDigest: z.string().regex(SHA_256_REF),
    dockerfileSha256: z.string().regex(HEX_64),
    lockfileSha256: z.string().regex(HEX_64),
    pnpmVersion: z.string().min(1),
  })
  .strict() satisfies z.ZodType<ImageInputs>
export type Image = z.infer<typeof ImageSchema>

/** A full lowercase commit sha: what a pin is, and what keys a target's images. */
export const commitSha = z.string().regex(COMMIT, "pin must be a full lowercase commit sha")

/**
 * The manifest as 3a wrote it carried one `image`, prepared at the manifest's `pin`. It is
 * read as that pin's entry of `images`; the prepare script writes only `images`. A manifest
 * carrying both is not migrated, so the strict schema refuses the leftover `image`.
 */
function migrateSingleImage(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw
  const record = raw as Record<string, unknown>
  if (!("image" in record) || "images" in record) return raw
  const { image, ...rest } = record
  return typeof rest.pin === "string" ? { ...rest, images: { [rest.pin]: image } } : raw
}

const TargetObjectSchema = z
  .object({
    id: z.string().min(1),
    /** The target's DEFAULT pin: what a shipped task runs at, and what `target:prepare` prepares without `--pin`. */
    pin: commitSha,
    root: z.union([z.literal("."), relativePath]),
    capture: z.object({ include: z.array(relativePath).min(1) }).strict(),
    /** Root-relative prefixes a suite may write under; the tamper comparison skips them. */
    snapshotIgnore: z.array(pathPrefix),
    /**
     * One image per pin it was prepared at (`target:prepare <id> --pin <sha>`). Absent until
     * the prepare script has run at least once; a pin with no entry is `image_unprepared`.
     */
    images: z.record(commitSha, ImageSchema).optional(),
    /** Repository paths copied into the image build context at the pin. */
    imageContext: z.array(relativePath).min(1),
    /** Repository path of the lockfile whose sha256 enters the image object. */
    lockfile: relativePath,
    /** Module specifiers that must resolve from `commands.cwd` inside the built image. */
    imageAssertResolves: z.array(z.string().min(1)),
    environmentLinks: z
      .array(z.object({ path: relativePath, target: z.string().min(1) }).strict())
      .min(1),
    commands: z
      .object({
        cwd: z.union([z.literal("."), relativePath]),
        build: z.array(z.string().min(1)),
        test: z.array(z.string().min(1)).min(1),
        nodeTestExecArgv: z.array(z.string().min(1)),
      })
      .strict(),
    /** Files the test command reads to decide what to run; every task must keep them immutable. */
    runnerConfig: z.array(relativePath).min(1),
    resources: z
      .object({
        memoryMb: z.number().int().positive(),
        cpus: z.number().positive(),
        commandTimeoutMs: z.number().int().positive(),
        verifierDeadlineMs: z.number().int().positive(),
      })
      .strict(),
  })
  .strict()
export const TargetSchema = z.preprocess(migrateSingleImage, TargetObjectSchema)
export type TargetManifest = z.infer<typeof TargetObjectSchema>

/**
 * A target as loaded AT one pin: `pin` is the chosen pin (the work order's, or the
 * manifest's default) and `image` is the image prepared at it, so everything downstream
 * (`imageTag`, the archive, the providers) reads one pin and one image.
 */
export interface Target extends Omit<TargetManifest, "images"> {
  readonly directory: string
  /** Present: `loadTarget` refuses a pin without one. */
  readonly image: Image
}

export interface CatalogOptions {
  readonly targetsDir?: string
  readonly tasksDir?: string
  readonly repositoryRoot?: string
  /** The pin to load the target at; the manifest's own `pin` when absent. */
  readonly pin?: string
}

/** The one spelling of the command an operator runs to prepare `id` at `pin`. */
export function prepareCommand(id: string, pin: string): string {
  return `pnpm --filter @b4-example/software-factory-controller target:prepare ${id} --pin ${pin}`
}

/** No target directory of that id: the one catalog failure no operator action at a pin mends. */
export class UnknownTargetError extends Error {
  constructor(readonly targetId: string) {
    super(`Unknown target: ${targetId}`)
    this.name = "UnknownTargetError"
  }
}

/**
 * The target exists, but has no image at the pin asked for: an operator prepares one with
 * `prepareCommand(id, pin)`. A work order at this pin is refused as `image_unprepared`, which
 * no redraft can mend.
 */
export class ImageUnpreparedError extends Error {
  constructor(
    readonly targetId: string,
    readonly pin: string,
  ) {
    super(
      `Target ${targetId} has no image prepared at ${pin}: run ${prepareCommand(targetId, pin)}`,
    )
    this.name = "ImageUnpreparedError"
  }
}

/**
 * The target has no image at ANY pin: nobody has prepared it on this machine. A case of
 * `ImageUnpreparedError` (the same operator action mends it) with its own message.
 */
export class TargetUnpreparedError extends ImageUnpreparedError {
  constructor(targetId: string, pin: string) {
    super(targetId, pin)
    this.message = `Target ${targetId} has not been prepared: run ${prepareCommand(targetId, pin)}`
    this.name = "TargetUnpreparedError"
  }
}

/**
 * The repository the factory targets: this one. `FACTORY_REPO_ROOT` exists because the
 * Docker-lane tests copy the app to a temporary root outside the repository, where
 * `git rev-parse` has nothing to find.
 */
export function repositoryRoot(): string {
  const fromEnv = process.env.FACTORY_REPO_ROOT
  if (fromEnv) return fromEnv
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: appRoot,
      encoding: "utf8",
      timeout: 10_000,
    }).trim()
  } catch (error) {
    throw new Error(
      `Cannot resolve the target repository from ${appRoot}: set FACTORY_REPO_ROOT (${String(error)})`,
    )
  }
}

/**
 * A catalog id is a plain directory name: no slash, no leading dot, nothing a path could
 * smuggle. `taskDirectory` joins it under a root, and this rule is what keeps it under one.
 */
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export function isCatalogId(id: string): boolean {
  return CATALOG_ID.test(id)
}

/** Ids present in `dir`, sorted: each is a directory, not a code change. */
function readIds(dir: string, label: string): string[] {
  const ids = readIdsIfPresent(dir)
  if (ids === null) throw new Error(`No ${label} catalog at ${dir}`)
  return ids
}

/**
 * As `readIds`, but null when `dir` does not exist: a catalog that may not exist yet. A
 * directory whose name is not a catalog id is not listed: `taskDirectory` would refuse it.
 */
function readIdsIfPresent(dir: string): string[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isCatalogId(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/**
 * Is `id` a task of the SHIPPED catalog (`dir`, the operator-prepared one), as opposed to a
 * generated task the search path can also resolve? `create --task` is answered by this and
 * not by `loadTask`: a generated directory left on disk by a refused or unapproved draft
 * would otherwise be creatable as a catalog work order, with no task digest for the gate to
 * bind, and the intake gate would be bypassed.
 */
export function isShippedTask(id: string, dir = tasksDir): boolean {
  return isCatalogId(id) && existsSync(join(dir, id, "task.json"))
}

/** Target ids present on disk, sorted. A new target is a directory, not a code change. */
export function loadTargetIds(dir = targetsDir): string[] {
  return readIds(dir, "target")
}

export function loadTarget(id: string, options: CatalogOptions = {}): Target {
  const dir = options.targetsDir ?? targetsDir
  if (!loadTargetIds(dir).includes(id)) throw new UnknownTargetError(id)
  const directory = join(dir, id)
  const manifest = TargetSchema.parse(
    JSON.parse(readFileSync(join(directory, "target.json"), "utf8")),
  )
  if (manifest.id !== id) throw new Error(`Target ${id} declares a different id: ${manifest.id}`)
  const pin = options.pin ?? manifest.pin
  if (!manifest.images || Object.keys(manifest.images).length === 0)
    throw new TargetUnpreparedError(id, pin)
  // Looked up before the pin is fetched: a pin with no image is refused without a network
  // round trip, and is refused the same way whether or not the object store holds it.
  const image = Object.hasOwn(manifest.images, pin) ? manifest.images[pin] : undefined
  if (!image) throw new ImageUnpreparedError(id, pin)
  const repo = options.repositoryRoot ?? repositoryRoot()
  ensurePin(repo, id, pin)
  const { images: _images, ...single } = manifest
  return { ...single, pin, image, directory }
}

/**
 * Make `pin` available in `repo`'s object store, fetching it from `origin` on a miss.
 *
 * A shallow checkout — which is what most CI jobs get — does not contain the pin, and the
 * pin is the only source of truth for what the factory builds against. Fetching that one
 * commit by SHA (GitHub allows it for a reachable commit) keeps that honest without
 * requiring every job in the repository to deepen its checkout. `FACTORY_NO_FETCH=1` turns
 * a missing pin back into a hard error, for offline or determinism runs. `options.label`
 * names the pinning thing in messages when it is not a target (`Target ${id}` otherwise).
 */
export function ensurePin(
  repo: string,
  id: string,
  pin: string,
  options: { readonly label?: string } = {},
): void {
  if (commitExists(repo, pin)) return
  const label = options.label ?? `Target ${id}`
  const missing = `${label} pins ${pin}, which is not in the repository at ${repo}`
  if (process.env.FACTORY_NO_FETCH === "1")
    throw new Error(`${missing} (FACTORY_NO_FETCH=1, not fetched)`)
  process.stderr.write(
    `factory: pin ${pin.slice(0, 12)} for ${label} is not in the local object store; fetching it from origin\n`,
  )
  try {
    execFileSync("git", ["-C", repo, "fetch", ...pinFetchDepth(repo), "origin", pin], {
      stdio: ["ignore", "ignore", "inherit"],
      timeout: 120_000,
    })
  } catch (error) {
    throw new Error(`${missing} (fetching it from origin also failed: ${String(error)})`)
  }
  if (!commitExists(repo, pin))
    throw new Error(`${missing} (fetching it from origin also failed: the fetch did not add it)`)
}

/**
 * `--depth=1` only for a checkout that is already shallow (CI's): there it fetches the one
 * commit and nothing else. On a full clone the same flag would make the clone shallow
 * (`.git/shallow`, shared by every linked worktree, truncating history for all of them), and
 * a plain fetch of a full clone is already incremental. A probe that fails reads as full: the
 * plain fetch is the one that cannot damage the clone.
 */
function pinFetchDepth(repo: string): string[] {
  try {
    const shallow = execFileSync("git", ["-C", repo, "rev-parse", "--is-shallow-repository"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim()
    return shallow === "true" ? ["--depth=1"] : []
  } catch {
    return []
  }
}

function commitExists(repo: string, pin: string): boolean {
  try {
    execFileSync("git", ["-C", repo, "cat-file", "-e", `${pin}^{commit}`], {
      stdio: "ignore",
      timeout: 10_000,
    })
    return true
  } catch {
    return false
  }
}

/**
 * The tag the prepare script builds and the sandbox provider runs. Derived, never stored.
 * Binds both the pin and the Dockerfile hash: a changed Dockerfile at the same pin must
 * never run under the old recorded identity.
 */
export function imageTag(target: Pick<Target, "id" | "pin" | "image">): string {
  return `b4-factory-${target.id}:${target.pin.slice(0, 12)}-${target.image.dockerfileSha256.slice(0, 12)}`
}

/**
 * The environment identity every receipt and bundle binds for this target at its pin. The
 * pin is folded in: two pins whose Dockerfile and lockfile agree build two images, and a
 * verdict earned in one must not be bound to the other.
 */
export function environmentIdentity(target: Pick<Target, "image" | "pin">): string {
  return environmentIdentityDigest(target.image, target.pin)
}

/**
 * A suite file: canonical (see `relativePath`) and named like a test file. Canonical because
 * the independent suite is written into the workspace by the verifier itself — a `..`
 * segment there would be a write outside the directory it believes it owns.
 */
const suiteFile = relativePath.refine(
  (p) => /\.test\.(?:ts|mjs|js)$/.test(p),
  "a suite file must end in .test.ts, .test.mjs or .test.js",
)
/** A file inside the target workspace, never under the root checks/ directory the verifier owns. */
const visibleSuiteFile = suiteFile.refine(
  (p) => !covers(["checks"], p),
  "a visible suite cannot live under checks/",
)
/** Written by the verifier to checks/ at the workspace root; must live there. */
const independentSuiteFile = suiteFile.refine(
  (p) => p.startsWith("checks/"),
  "the independent check must live under checks/",
)

/** A node-test suite naming `file`, generic so the visible and independent suites can use
 * their own, distinct file rules. */
function nodeTestSuite<F extends z.ZodType<string>>(file: F) {
  return z
    .object({ runner: z.literal("node-test"), file, assertions: z.array(z.string().min(1)).min(1) })
    .strict()
}

/**
 * A vitest suite may name no assertions: an empty list means "the target's whole suite must
 * pass", which is what a generated task's visible suite carries as its regression guard. A
 * node-test suite still needs names, because the verifier greps the suite's events for them.
 */
const VitestSuiteSchema = z
  .object({ runner: z.literal("vitest"), assertions: z.array(z.string().min(1)).min(0) })
  .strict()
const VisibleNodeTestSuiteSchema = nodeTestSuite(visibleSuiteFile)
const IndependentSuiteSchema = nodeTestSuite(independentSuiteFile)

export const SuiteSchema = z.discriminatedUnion("runner", [
  VisibleNodeTestSuiteSchema,
  VitestSuiteSchema,
])
export type Suite = z.infer<typeof SuiteSchema>
export type NodeTestSuite = z.infer<typeof IndependentSuiteSchema>
export type VitestSuite = z.infer<typeof VitestSuiteSchema>

/** The independent suite is always a node-test file the verifier writes in itself. */
export const ChecksSchema = z
  .object({ visible: SuiteSchema, independent: IndependentSuiteSchema })
  .strict()
export type Checks = z.infer<typeof ChecksSchema>

/**
 * A path the builder may change. Never a test file, a bare `checks` entry, or anything
 * under `checks/`: the factory's completion policy must not be reachable from the
 * builder's own inventory. The target's runner configuration is checked in `loadTask`,
 * where the target is known.
 */
const allowedSourcePath = relativePath
  .refine((p) => !/\.test\.[a-z]+$/.test(p), "a test file cannot be an allowed source path")
  .refine((p) => !covers(["checks"], p), "a check cannot be an allowed source path")

/**
 * The manifest's shape alone, before the disjointness rule below. Exported so an intake
 * draft, which carries every field but `id`, can derive its own schema (zod refuses
 * `.omit()` on a refined object); a filled manifest is then re-parsed with `TaskSchema`.
 */
export const TaskFieldsSchema = z
  .object({
    id: z.string().min(1),
    target: z.string().min(1),
    /**
     * The pin the task runs at. A generated task carries its work order's; a shipped task
     * omits it and runs at its target's default pin.
     */
    pin: commitSha.optional(),
    allowedSourcePaths: z.array(allowedSourcePath).min(1),
    immutablePaths: z.array(relativePath),
  })
  .strict()

export const TaskSchema = TaskFieldsSchema.refine(
  (m) => m.allowedSourcePaths.every((p) => m.immutablePaths.every((e) => !overlaps(p, e))),
  "allowed and immutable paths must be disjoint",
)
export type TaskManifest = z.infer<typeof TaskSchema>

export interface Task {
  readonly id: string
  readonly directory: string
  readonly target: Target
  readonly manifest: TaskManifest
  readonly checks: Checks
  /** `spec.md`; hashed into the specification digest and shown to the builder as TASK.md. */
  readonly specText: string
  /** Null when the pinned bytes are already the defective baseline. */
  readonly defectPatch: string | null
  /** Null for a generated task: nothing proves it is repairable until a builder does. */
  readonly referencePatch: string | null
}

/**
 * Where tasks are looked up: the shipped catalog first, then the directory the controller
 * writes generated tasks into. Process-wide state, configured by the runtime from the state
 * directory (one runtime per process is the runtime's own contract); every `loadTask(id)`
 * call site then resolves a generated task with no signature change. A shipped id shadows
 * a generated one, so a generated task can never impersonate a task an operator prepared
 * by hand.
 */
let generatedTasksDir: string | undefined
export function configureCatalog(options: { readonly generatedTasksDir?: string }): void {
  generatedTasksDir = options.generatedTasksDir
}
export function resetCatalogForTests(): void {
  generatedTasksDir = undefined
}
/** An explicit `tasksDir` is looked up alone; otherwise the search path, shipped first. */
function taskRoots(options: CatalogOptions): readonly [string, ...string[]] {
  if (options.tasksDir) return [options.tasksDir]
  return generatedTasksDir ? [tasksDir, generatedTasksDir] : [tasksDir]
}

/**
 * Task ids present on disk, sorted within each root: the shipped catalog's first, then the
 * generated ones not already named by a shipped task. A new task is a directory, not a code
 * change. The shipped catalog must exist (`No task catalog`); the generated directory is
 * absent until the first draft lands, which is not an error. A generated directory counts
 * only once it holds `task.json`: an intake in flight has a directory before it has a task,
 * and what is listed must be what `loadTask` can find.
 */
export function loadTaskIds(dir?: string): string[] {
  const [first, ...rest]: readonly [string, ...string[]] = dir ? [dir] : taskRoots({})
  const ids = readIds(first, "task")
  for (const root of rest)
    for (const id of readIdsIfPresent(root) ?? [])
      if (!ids.includes(id) && existsSync(join(root, id, "task.json"))) ids.push(id)
  return ids
}

/**
 * The first root on the search path that holds `id`'s manifest. An id that is not a plain
 * directory name is unknown before the filesystem is touched: `../x` must never resolve
 * to a task.json outside every root, whatever id that file declares.
 */
function taskDirectory(id: string, options: CatalogOptions): string {
  if (!isCatalogId(id)) throw new Error(`Unknown task: ${id}`)
  for (const root of taskRoots(options))
    if (existsSync(join(root, id, "task.json"))) return join(root, id)
  throw new Error(`Unknown task: ${id}`)
}

/**
 * Does `manifest` fit `target`: no allowed path may reach the runner configuration, every
 * runner configuration path is kept immutable, and a node-test visible suite is itself kept
 * immutable. A vitest visible suite runs inside the target's own test command rather than as
 * a file the builder could edit directly, so keeping the directory that holds it immutable
 * is the task author's job instead (the devkit task lists `packages/devkit/test`).
 */
export function assertTaskFitsTarget(
  id: string,
  manifest: TaskManifest,
  checks: Checks,
  target: Pick<Target, "runnerConfig">,
): void {
  for (const path of manifest.allowedSourcePaths)
    if (target.runnerConfig.some((entry) => overlaps(path, entry)))
      throw new Error(`Task ${id} may edit ${path}, which is the target's runner configuration`)
  for (const path of target.runnerConfig)
    if (!covers(manifest.immutablePaths, path))
      throw new Error(`Task ${id}: runner configuration ${path} must be immutable`)
  if (
    checks.visible.runner === "node-test" &&
    !covers(manifest.immutablePaths, checks.visible.file)
  )
    throw new Error(`Task ${id}: visible suite ${checks.visible.file} must be immutable`)
}

/** Parse `raw` against `schema`, rethrowing a schema failure with task-scoped context. */
function parseTaskFile<T>(schema: z.ZodType<T>, raw: unknown, id: string, file: string): T {
  const result = schema.safeParse(raw)
  if (!result.success)
    throw new Error(`Task ${id}: invalid ${file}: ${result.error}`, { cause: result.error })
  return result.data
}

/**
 * A patch that may be absent: `defect.patch` when the pinned bytes are already defective,
 * `reference.patch` for a generated task nothing has repaired yet.
 */
function readOptionalPatch(directory: string, name: string): string | null {
  try {
    return readFileSync(join(directory, name), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export function loadTask(id: string, options: CatalogOptions = {}): Task {
  const directory = taskDirectory(id, options)
  const manifest = parseTaskFile(
    TaskSchema,
    JSON.parse(readFileSync(join(directory, "task.json"), "utf8")),
    id,
    "task.json",
  )
  if (manifest.id !== id) throw new Error(`Task ${id} declares a different id: ${manifest.id}`)
  const target = loadTarget(
    manifest.target,
    manifest.pin !== undefined ? { ...options, pin: manifest.pin } : options,
  )
  const checks = parseTaskFile(
    ChecksSchema,
    JSON.parse(readFileSync(join(directory, "checks.json"), "utf8")),
    id,
    "checks.json",
  )
  assertTaskFitsTarget(id, manifest, checks, target)
  const checkFile = join(directory, checks.independent.file)
  if (!existsSync(checkFile))
    throw new Error(`Task ${id} names a missing check: ${checks.independent.file}`)
  const specPath = join(directory, "spec.md")
  if (!existsSync(specPath)) throw new Error(`Task ${id} is missing spec.md`)
  return {
    id,
    directory,
    target,
    manifest,
    checks,
    specText: readFileSync(specPath, "utf8"),
    defectPatch: readOptionalPatch(directory, "defect.patch"),
    referencePatch: readOptionalPatch(directory, "reference.patch"),
  }
}
