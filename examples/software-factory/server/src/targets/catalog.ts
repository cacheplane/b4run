import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { environmentIdentityDigest, type ImageInputs } from "../domain/digest.js"

/** The package root, derived from this module rather than the working directory. */
export const appRoot = fileURLToPath(new URL("../../", import.meta.url))
export const targetsDir = join(appRoot, "targets")
export const tasksDir = join(appRoot, "tasks")

const HEX_64 = /^[a-f0-9]{64}$/
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
const relativePath = z
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

export const TargetSchema = z
  .object({
    id: z.string().min(1),
    pin: z.string().regex(/^[a-f0-9]{40}$/, "pin must be a full lowercase commit sha"),
    root: z.union([z.literal("."), relativePath]),
    capture: z.object({ include: z.array(relativePath).min(1) }).strict(),
    /** Root-relative prefixes a suite may write under; the tamper comparison skips them. */
    snapshotIgnore: z.array(pathPrefix),
    /** Absent until `scripts/prepare-target.ts` has run for this pin. */
    image: ImageSchema.optional(),
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
export type TargetManifest = z.infer<typeof TargetSchema>

export interface Target extends TargetManifest {
  readonly directory: string
  /** Present: `loadTarget` refuses a manifest without one. */
  readonly image: Image
}

export interface CatalogOptions {
  readonly targetsDir?: string
  readonly tasksDir?: string
  readonly repositoryRoot?: string
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

/** Target ids present on disk, sorted. A new target is a directory, not a code change. */
export function loadTargetIds(dir = targetsDir): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`No target catalog at ${dir}`)
    throw error
  }
}

export function loadTarget(id: string, options: CatalogOptions = {}): Target {
  const dir = options.targetsDir ?? targetsDir
  if (!loadTargetIds(dir).includes(id)) throw new Error(`Unknown target: ${id}`)
  const directory = join(dir, id)
  const manifest = TargetSchema.parse(
    JSON.parse(readFileSync(join(directory, "target.json"), "utf8")),
  )
  if (manifest.id !== id) throw new Error(`Target ${id} declares a different id: ${manifest.id}`)
  if (!manifest.image)
    throw new Error(`Target ${id} has not been prepared: run scripts/prepare-target.ts ${id}`)
  const repo = options.repositoryRoot ?? repositoryRoot()
  if (!commitExists(repo, manifest.pin))
    throw new Error(`Target ${id} pins ${manifest.pin}, which is not in the repository at ${repo}`)
  return { ...manifest, image: manifest.image, directory }
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

/** The environment identity every receipt and bundle binds for this target. */
export function environmentIdentity(target: Pick<Target, "image">): string {
  return environmentIdentityDigest(target.image)
}

const NodeTestSuiteSchema = z
  .object({
    runner: z.literal("node-test"),
    file: z.string().regex(/^(?:test|checks)\/[\w./-]+\.test\.(?:ts|mjs|js)$/),
    assertions: z.array(z.string().min(1)).min(1),
  })
  .strict()
const VitestSuiteSchema = z
  .object({ runner: z.literal("vitest"), assertions: z.array(z.string().min(1)).min(1) })
  .strict()
export const SuiteSchema = z.discriminatedUnion("runner", [NodeTestSuiteSchema, VitestSuiteSchema])
export type Suite = z.infer<typeof SuiteSchema>
export type NodeTestSuite = z.infer<typeof NodeTestSuiteSchema>
export type VitestSuite = z.infer<typeof VitestSuiteSchema>

/** The independent suite is always a node-test file the verifier writes in itself. */
export const ChecksSchema = z
  .object({ visible: SuiteSchema, independent: NodeTestSuiteSchema })
  .strict()
export type Checks = z.infer<typeof ChecksSchema>

/**
 * Does one of `entries` cover `path`? An entry is a file or a directory; a directory covers
 * everything under it. Paths are canonical (see `relativePath`), so string comparison is exact.
 */
export function covers(entries: readonly string[], path: string): boolean {
  return entries.some((entry) => path === entry || path.startsWith(`${entry}/`))
}

/**
 * A path the builder may change. Never a test or a check: the factory's completion policy
 * must not be reachable from the builder's own inventory. The target's runner configuration
 * is checked in `loadTask`, where the target is known.
 */
const allowedSourcePath = relativePath
  .refine((p) => !p.endsWith(".test.ts"), "a test file cannot be an allowed source path")
  .refine((p) => !p.startsWith("checks/"), "a check cannot be an allowed source path")

export const TaskSchema = z
  .object({
    id: z.string().min(1),
    target: z.string().min(1),
    allowedSourcePaths: z.array(allowedSourcePath).min(1),
    immutablePaths: z.array(relativePath),
  })
  .strict()
  .refine(
    (m) => m.allowedSourcePaths.every((p) => !covers(m.immutablePaths, p)),
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
  readonly referencePatch: string
}

/** Task ids present on disk, sorted. A new task is a directory, not a code change. */
export function loadTaskIds(dir = tasksDir): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`No task catalog at ${dir}`)
    throw error
  }
}

export function loadTask(id: string, options: CatalogOptions = {}): Task {
  const dir = options.tasksDir ?? tasksDir
  if (!loadTaskIds(dir).includes(id)) throw new Error(`Unknown task: ${id}`)
  const directory = join(dir, id)
  const manifest = TaskSchema.parse(JSON.parse(readFileSync(join(directory, "task.json"), "utf8")))
  if (manifest.id !== id) throw new Error(`Task ${id} declares a different id: ${manifest.id}`)
  const target = loadTarget(manifest.target, options)
  for (const path of manifest.allowedSourcePaths)
    if (covers(target.runnerConfig, path))
      throw new Error(`Task ${id} may edit ${path}, which is the target's runner configuration`)
  for (const path of target.runnerConfig)
    if (!covers(manifest.immutablePaths, path))
      throw new Error(`Task ${id}: runner configuration ${path} must be immutable`)
  const checks = ChecksSchema.parse(
    JSON.parse(readFileSync(join(directory, "checks.json"), "utf8")),
  )
  const checkFile = join(directory, checks.independent.file)
  if (!existsSync(checkFile))
    throw new Error(`Task ${id} names a missing check: ${checks.independent.file}`)
  const defectPath = join(directory, "defect.patch")
  return {
    id,
    directory,
    target,
    manifest,
    checks,
    specText: readFileSync(join(directory, "spec.md"), "utf8"),
    defectPatch: existsSync(defectPath) ? readFileSync(defectPath, "utf8") : null,
    referencePatch: readFileSync(join(directory, "reference.patch"), "utf8"),
  }
}
