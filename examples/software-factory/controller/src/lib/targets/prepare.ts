import { execFileSync } from "node:child_process"
import { parseArgs } from "node:util"
import { commitSha, type Image, type TargetManifest } from "./catalog.js"

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
 * Every repository path the image's inputs name, in the order a refusal should report
 * them: the workspace root (unless it is the repository itself), each build-context entry,
 * and the lockfile whose hash is recorded.
 */
export function pathsRequiredAtPin(
  manifest: Pick<TargetManifest, "root" | "imageContext" | "lockfile">,
): string[] {
  const paths = [
    ...(manifest.root === "." ? [] : [manifest.root]),
    ...manifest.imageContext,
    manifest.lockfile,
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
