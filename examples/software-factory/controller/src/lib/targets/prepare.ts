import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { writeFileAtomic } from "../storage/atomic-file.js"
import { appRoot, commitSha, type Image, type TargetManifest, TargetSchema } from "./catalog.js"

/**
 * The pure parts of `scripts/prepare-target.ts`: what it was asked to prepare, which
 * repository paths must exist at the pin for the image to mean anything, and the manifest it
 * writes back. The script itself is Docker and git; these are what a unit test can reach.
 */

export interface PrepareArgs {
  readonly id: string
  /** Absent: the manifest's own (default) pin. */
  readonly pin?: string
}

export function parsePrepareArgs(argv: readonly string[]): PrepareArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { pin: { type: "string" } },
    allowPositionals: true,
    strict: true,
  })
  const [id, ...extra] = positionals
  if (!id || extra.length > 0) throw new Error("usage: prepare-target.ts <target-id> [--pin <sha>]")
  if (values.pin === undefined) return { id }
  if (!commitSha.safeParse(values.pin).success)
    throw new Error(`--pin must be a full lowercase commit sha, got ${JSON.stringify(values.pin)}`)
  return { id, pin: values.pin }
}

/**
 * Every repository path the target names, in the order a refusal should report them: the
 * workspace root (unless it is the repository itself), each build-context entry, the
 * lockfile, and, under the root, every capture entry, the commands' working directory and
 * every runner configuration path. An image prepared at a pin where any of them is absent
 * would build, and then capture, run or guard nothing.
 */
export function pathsRequiredAtPin(
  manifest: Pick<
    TargetManifest,
    "root" | "imageContext" | "lockfile" | "capture" | "commands" | "runnerConfig"
  >,
): string[] {
  const underRoot = (path: string) => (manifest.root === "." ? path : `${manifest.root}/${path}`)
  const paths = [
    ...(manifest.root === "." ? [] : [manifest.root]),
    ...manifest.imageContext,
    manifest.lockfile,
    ...manifest.capture.include.map(underRoot),
    ...(manifest.commands.cwd === "." ? [] : [underRoot(manifest.commands.cwd)]),
    ...manifest.runnerConfig.map(underRoot),
  ]
  return [...new Set(paths)]
}

/**
 * The first required path that does not exist at `pin`, by `exists`. A target whose paths
 * moved (the `cli-flags` fixture lived under the server before the controller split) must be
 * refused by name at such a pin, not built from an archive that silently omits it.
 */
export function firstMissingPath(
  paths: readonly string[],
  exists: (path: string) => boolean,
): string | undefined {
  return paths.find((path) => !exists(path))
}

/** Does `path` (a file or a directory) exist in `repo` at `pin`? */
export function pathExistsAtPin(repo: string, pin: string, path: string): boolean {
  try {
    execFileSync("git", ["-C", repo, "cat-file", "-e", `${pin}:${path}`], {
      stdio: "ignore",
      timeout: 10_000,
    })
    return true
  } catch {
    return false
  }
}

/**
 * The manifest with `image` recorded at `pin`, every other pin's entry kept as it was, and
 * `images` written last whatever order the manifest on disk was in.
 */
export function withImageAt(
  manifest: TargetManifest,
  pin: string,
  image: Image,
): TargetManifest & { readonly images: Record<string, Image> } {
  const { images: previous, ...rest } = manifest
  return { ...rest, images: { ...(previous ?? {}), [pin]: image } }
}

/** Format `json` as the checked-in manifests are (Biome, from the app's own configuration). */
export function formatManifest(json: string): string {
  return execFileSync("npx", ["biome", "format", "--stdin-file-path=target.json"], {
    cwd: appRoot,
    input: json,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
    timeout: 60_000,
  })
}

/**
 * Record `image` at `pin` in the manifest at `path`, safely against everything that happened
 * during the (long) build: the manifest is RE-READ now, so another prepare's entry written
 * meanwhile is kept, only `images[pin]` is replaced, and the formatted bytes are renamed into
 * place, so a controller reading the file concurrently sees the old manifest or the new one,
 * never a torn one. `format` is injectable so a test needs no Biome.
 */
export async function recordImage(
  path: string,
  pin: string,
  image: Image,
  format: (json: string) => string = formatManifest,
): Promise<TargetManifest> {
  const current = TargetSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  const next = withImageAt(current, pin, image)
  await writeFileAtomic(path, format(`${JSON.stringify(next, null, 2)}\n`))
  return next
}
