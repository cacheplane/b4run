import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { commitSha, covers, type TargetManifest, type TargetRecipe } from "./catalog.js"

/**
 * The pure parts of preparing an image: what `scripts/prepare-target.ts` was asked to prepare,
 * and which repository paths must exist at the pin for the image to mean anything
 * (`recipeProblem`). The build itself is `image-builder.ts`; these are what a unit test can reach.
 */

interface PrepareArgs {
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

/**
 * The workspace packages a target's Dockerfile says the capture holds: the words of its
 * `CAPTURED="..."` assignment, or undefined when it declares none. The image cannot read the
 * manifest, so a Dockerfile that relinks packages by name restates the capture's list.
 */
export function dockerfileCapturedPackages(dockerfile: string): string[] | undefined {
  const match = /\bCAPTURED="([^"]*)"/.exec(dockerfile)
  if (!match) return undefined
  return (match[1] as string).split(/\s+/).filter((word) => word.length > 0)
}

/** The workspace packages (`packages/<p>`, under the target's root) its capture includes. */
export function capturedPackages(manifest: Pick<TargetManifest, "capture">): string[] {
  const packages = new Set<string>()
  for (const path of manifest.capture.include) {
    const match = /^packages\/([^/]+)(?:\/|$)/.exec(path)
    if (match) packages.add(match[1] as string)
  }
  return [...packages].sort()
}

/**
 * Why the Dockerfile's `CAPTURED` list disagrees with the capture, or undefined when it
 * agrees or declares none. A package captured but not relinked resolves to the image's
 * manifest-only copy (no `dist/`); one relinked but not captured is a link to nothing.
 */
export function capturedListMismatch(
  manifest: Pick<TargetManifest, "id" | "capture">,
  dockerfile: string,
): string | undefined {
  const declared = dockerfileCapturedPackages(dockerfile)
  if (declared === undefined) return undefined
  const captured = capturedPackages(manifest)
  const declaredSet = new Set(declared)
  const notRelinked = captured.filter((p) => !declaredSet.has(p))
  const notCaptured = [...declaredSet].filter((p) => !captured.includes(p)).sort()
  const repeated = declared.filter((p, i) => declared.indexOf(p) !== i)
  if (notRelinked.length === 0 && notCaptured.length === 0 && repeated.length === 0)
    return undefined
  const parts = [
    ...(notRelinked.length ? [`captured but not in CAPTURED: ${notRelinked.join(", ")}`] : []),
    ...(notCaptured.length ? [`in CAPTURED but not captured: ${notCaptured.join(", ")}`] : []),
    ...(repeated.length ? [`repeated in CAPTURED: ${repeated.join(", ")}`] : []),
  ]
  return `Target "${manifest.id}": its Dockerfile's CAPTURED list disagrees with capture.include (${parts.join("; ")})`
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
 * Why `recipe` cannot be built at its pin, or undefined. Each is refused by name before any
 * pull or build: a path the target names that the pin does not hold (`git archive` of it would
 * fail naming nothing useful, and the `cli-flags` fixture's paths moved); a Dockerfile whose
 * `CAPTURED` list disagrees with the capture; a lockfile outside the build context, whose hash
 * would record an input that did not produce the image.
 */
export function recipeProblem(
  recipe: TargetRecipe,
  repo: string,
  exists: (path: string) => boolean = (path) => pathExistsAtPin(repo, recipe.pin, path),
): string | undefined {
  const missing = firstMissingPath(pathsRequiredAtPin(recipe), exists)
  if (missing !== undefined)
    return `Target "${recipe.id}" names ${missing}, which does not exist at ${recipe.pin}: it cannot be prepared at that pin`
  const captured = capturedListMismatch(
    recipe,
    readFileSync(join(recipe.directory, "Dockerfile"), "utf8"),
  )
  if (captured !== undefined) return captured
  if (!covers(recipe.imageContext, recipe.lockfile))
    return `Target "${recipe.id}" records lockfile "${recipe.lockfile}", which its imageContext does not cover`
  return undefined
}
