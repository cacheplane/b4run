import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { WorkspaceDefinition } from "@b4run/workspace"
import { archiveTreeInto, CAPTURES_PREFIX } from "./archive.js"

/**
 * Where the repository lives inside the drafter's workspace. The drafter writes its four
 * files under `draft/` beside it, and the controller reads the thread re-rooted at `draft/`,
 * so this is the one prefix the intake prompt and the re-rooted read must agree on.
 */
export const WIDE_CAPTURE_ROOT = "repo"

const FULL_SHA = /^[a-f0-9]{40}$/
/** The framework's own portable-path rule (`packages/workspace/src/source-validation.ts`). */
const PORTABLE_PATH = /^[A-Za-z0-9._ /-]+$/

/** One include rule: whether a repository path is in the wide capture, and why. */
interface IncludeRule {
  readonly why: string
  readonly matches: (path: string) => boolean
}

const under = (prefix: string) => (path: string) => path.startsWith(prefix)
const packageFile = (pattern: RegExp) => (path: string) => pattern.test(path)

/**
 * What the drafter may see, as data: enough of the repository to name the allowed source
 * paths of a task and to write a check against them, and nothing that is not a target.
 * Every rule says why it is in. Order does not matter; a path is in when any rule matches
 * it and no exclusion below does.
 */
export const WIDE_CAPTURE_INCLUDE_RULES: readonly IncludeRule[] = [
  {
    why: "root manifests: the workspace layout, the lockfile and the shared configs the drafter reads to understand how packages are built and tested",
    matches: (path) =>
      [
        "package.json",
        "pnpm-workspace.yaml",
        "pnpm-lock.yaml",
        "turbo.json",
        "biome.json",
        ".npmrc",
      ].includes(path) || /^tsconfig[^/]*\.json$/.test(path),
  },
  {
    why: "each package's manifest, compiler config and README: what a target is, its scripts and its module layout",
    matches: packageFile(/^packages\/[^/]+\/(?:package\.json|tsconfig[^/]*\.json|README\.md)$/),
  },
  {
    why: "package sources: the drafter names allowed source paths and must have seen the code they point at",
    matches: packageFile(/^packages\/[^/]+\/src\//),
  },
  {
    why: "package tests: the drafter writes a check in the target's testing idiom and must not duplicate an existing suite",
    matches: packageFile(/^packages\/[^/]+\/test\//),
  },
  {
    why: "repository scripts: the gates a work order may be about, and the shape of a runnable script",
    matches: under("scripts/"),
  },
]

/**
 * What is taken back out of what the rules above selected. `apps/`, `examples/` and `docs/`
 * are never selected in the first place: they are not targets. These are the holes inside
 * selected directories.
 */
export const WIDE_CAPTURE_EXCLUDE_RULES: readonly IncludeRule[] = [
  {
    why: "release fixtures hold binaries (a .tar.gz among them) the drafter has no use for",
    matches: under("scripts/release/test/fixtures/"),
  },
  {
    why: "a path the framework's capture would refuse: dropped by rule here rather than failing the whole capture there",
    matches: (path) => !PORTABLE_PATH.test(path),
  },
]

/**
 * The exact, sorted list of repository paths the wide capture holds at `pin`: every blob of
 * `git ls-tree -r <pin>` (symlinks and submodules are not blobs, and the framework's capture
 * refuses symlinks) that an include rule selects and no exclude rule removes. Read from the
 * object store, never from the working tree, so two captures of one pin are identical.
 */
export function wideCaptureInclude(repositoryRoot: string, pin: string): string[] {
  if (!FULL_SHA.test(pin)) throw new Error(`wide capture pin must be a full commit sha: ${pin}`)
  let listing: string
  try {
    listing = execFileSync("git", ["-C", repositoryRoot, "ls-tree", "-r", "-z", pin], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    })
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? String(error)
    throw new Error(`git ls-tree of ${pin} in ${repositoryRoot} failed: ${stderr}`, {
      cause: error,
    })
  }
  const include: string[] = []
  for (const entry of listing.split("\0")) {
    if (entry.length === 0) continue
    // `<mode> <type> <object>\t<path>`; `-z` keeps the path unquoted whatever it contains.
    const tab = entry.indexOf("\t")
    const [mode, type] = entry.slice(0, tab).split(" ")
    const path = entry.slice(tab + 1)
    if (type !== "blob" || mode === "120000") continue
    if (!WIDE_CAPTURE_INCLUDE_RULES.some((rule) => rule.matches(path))) continue
    if (WIDE_CAPTURE_EXCLUDE_RULES.some((rule) => rule.matches(path))) continue
    include.push(path)
  }
  return include.sort()
}

export interface StageWideCaptureOptions {
  /**
   * The capture root `instanceDir` is relative to: the controller's `FACTORY_STATE_DIR`,
   * never its app root (see `CaptureTargetOptions.captureRoot` in `archive.ts`).
   */
  readonly captureRoot: string
}

/** Every capture directory lives here; `stageWideCapture` removes nothing outside it. */
export { CAPTURES_PREFIX }

/** `instanceDir` is not a directory `stageWideCapture` may own, so nothing was touched. */
export class CaptureDirectoryError extends Error {
  override readonly name = "CaptureDirectoryError"
}

/**
 * Is `instanceDir` a canonical capture-root-relative path under {@link CAPTURES_PREFIX}: forward
 * slashes only, no leading slash, no empty, `.` or `..` segment, and at least one segment
 * below the prefix? Checked before the `rmSync` that rebuilds it, because that removal is
 * recursive and `instanceDir` comes from the caller: an empty string or `.` would name the
 * capture root itself (the state directory, registry and all).
 */
function assertCaptureDirectory(instanceDir: string): void {
  const segments = instanceDir.split("/")
  const canonical =
    !instanceDir.includes("\\") &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  if (!canonical || !instanceDir.startsWith(CAPTURES_PREFIX))
    throw new CaptureDirectoryError(
      `wide capture staging directory must be a canonical path under ${CAPTURES_PREFIX}, got ${JSON.stringify(instanceDir)}`,
    )
}

/**
 * Archive the wide capture at `pin` under `<captureRoot>/<instanceDir>/repo/` and describe it
 * as a workspace: the repository under {@link WIDE_CAPTURE_ROOT}, no environment links (the
 * drafter runs nothing that needs a dependency tree) and NO baseline (there is no `.git`
 * for the drafter to diff against, and nothing it writes is read as a diff).
 *
 * `instanceDir` is capture-root-relative and forward-slash, which is what the framework's capture
 * takes as `source.directory`, and must lie under {@link CAPTURES_PREFIX} (see
 * {@link assertCaptureDirectory}); `captureDirectory` in `archive.ts` is how a caller
 * names one. The caller owns it and removes it once the capture has read the bytes into
 * the definition (see `captureDrafterHandoff`). The archive mechanics are
 * {@link archiveTreeInto}'s, with the include as an explicit file list and `repo/` as the
 * prefix, so an executable script keeps its bit on disk and the framework records it.
 *
 * Synchronous throughout (`git ls-tree`, `git archive`, `tar`): nothing here is cancellable
 * by a signal; a caller that holds one checks it before and after.
 */
export function stageWideCapture(
  repositoryRoot: string,
  pin: string,
  instanceDir: string,
  options: StageWideCaptureOptions,
): WorkspaceDefinition {
  assertCaptureDirectory(instanceDir)
  const include = wideCaptureInclude(repositoryRoot, pin)
  const absolute = join(options.captureRoot, instanceDir)
  rmSync(absolute, { recursive: true, force: true })
  mkdirSync(absolute, { recursive: true })
  try {
    archiveTreeInto(repositoryRoot, pin, include, absolute, {
      prefix: `${WIDE_CAPTURE_ROOT}/`,
      label: "wide capture",
    })
  } catch (error) {
    rmSync(absolute, { recursive: true, force: true })
    throw error
  }
  return {
    source: {
      directory: instanceDir,
      include: include.map((path) => `${WIDE_CAPTURE_ROOT}/${path}`),
    },
    environmentLinks: [],
  }
}
