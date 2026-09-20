import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
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

/** A relative, forward-slash path with no `..` segment and no leading slash. */
const relativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes("..") && !p.includes("\\"), {
    message: "must be a relative forward-slash path with no `..` segment",
  })

export const ImageSchema = z.object({
  localId: z.string().regex(SHA_256_REF),
  platform: z.string().min(1),
  baseManifestDigest: z.string().regex(SHA_256_REF),
  dockerfileSha256: z.string().regex(HEX_64),
  lockfileSha256: z.string().regex(HEX_64),
  pnpmVersion: z.string().min(1),
}) satisfies z.ZodType<ImageInputs>
export type Image = z.infer<typeof ImageSchema>

export const TargetSchema = z.object({
  id: z.string().min(1),
  pin: z.string().regex(/^[a-f0-9]{40}$/, "pin must be a full lowercase commit sha"),
  root: z.union([z.literal("."), relativePath]),
  capture: z.object({ include: z.array(relativePath).min(1) }),
  /** Root-relative prefixes a suite may write under; the tamper comparison skips them. */
  snapshotIgnore: z.array(relativePath),
  /** Absent until `scripts/prepare-target.ts` has run for this pin. */
  image: ImageSchema.optional(),
  /** Repository paths copied into the image build context at the pin. */
  imageContext: z.array(relativePath).min(1),
  /** Repository path of the lockfile whose sha256 enters the image object. */
  lockfile: relativePath,
  /** Module specifiers that must resolve from `commands.cwd` inside the built image. */
  imageAssertResolves: z.array(z.string().min(1)),
  environmentLinks: z.array(z.object({ path: relativePath, target: z.string().min(1) })).min(1),
  commands: z.object({
    cwd: z.union([z.literal("."), relativePath]),
    build: z.array(z.string().min(1)),
    test: z.array(z.string().min(1)).min(1),
    nodeTestExecArgv: z.array(z.string().min(1)),
  }),
  /** Files the test command reads to decide what to run; every task must keep them immutable. */
  runnerConfig: z.array(relativePath).min(1),
  resources: z.object({
    memoryMb: z.number().int().positive(),
    cpus: z.number().positive(),
    commandTimeoutMs: z.number().int().positive(),
    verifierDeadlineMs: z.number().int().positive(),
  }),
})
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
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
}

/** Target ids present on disk, sorted. A new target is a directory, not a code change. */
export function loadTargetIds(dir = targetsDir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
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
    execFileSync("git", ["-C", repo, "cat-file", "-e", `${pin}^{commit}`], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/** The tag the prepare script builds and the sandbox provider runs. Derived, never stored. */
export function imageTag(target: Pick<Target, "id" | "pin">): string {
  return `b4-factory-${target.id}:${target.pin.slice(0, 12)}`
}

/** The environment identity every receipt and bundle binds for this target. */
export function environmentIdentity(target: Pick<Target, "image">): string {
  return environmentIdentityDigest(target.image)
}
