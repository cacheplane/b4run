import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { WorkspaceDefinition } from "@b4run/workspace"
import { appRoot as defaultAppRoot } from "./catalog.js"

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
  /** The app root `instanceDir` is relative to; the catalog's own by default. */
  readonly appRoot?: string
}

/**
 * Archive the wide capture at `pin` under `<appRoot>/<instanceDir>/repo/` and describe it
 * as a workspace: the repository under {@link WIDE_CAPTURE_ROOT}, no environment links (the
 * drafter runs nothing that needs a dependency tree) and NO baseline (there is no `.git`
 * for the drafter to diff against, and nothing it writes is read as a diff).
 *
 * `instanceDir` is app-relative and forward-slash, which is what the framework's capture
 * takes as `source.directory`; the caller owns it and removes it once the capture has read
 * the bytes into the definition (see `writeDrafterManifest`). The `git archive` mechanics
 * are `captureTarget`'s (`archive.ts`), generalised to an explicit file list and a prefix:
 * the archive is written from the object store, so the working tree is invisible, and the
 * tar carries each blob's mode, so an executable script keeps its bit on disk and the
 * framework records it. Every path is asserted present after extraction because
 * `git archive` silently honours an in-tree `export-ignore` attribute.
 *
 * The paths go on the command line: the wide capture is about 1,400 entries and 60 KiB of
 * arguments, far under the platform limits, and `git archive` takes no pathspec file.
 */
export function stageWideCapture(
  repositoryRoot: string,
  pin: string,
  instanceDir: string,
  options: StageWideCaptureOptions = {},
): WorkspaceDefinition {
  const include = wideCaptureInclude(repositoryRoot, pin)
  const absolute = join(options.appRoot ?? defaultAppRoot, instanceDir)
  rmSync(absolute, { recursive: true, force: true })
  mkdirSync(absolute, { recursive: true })
  try {
    // The tar lives INSIDE the instance directory so a failure leaves nothing beside it.
    const tar = join(absolute, ".b4-wide-archive.tar")
    try {
      execFileSync(
        "git",
        [
          "-C",
          repositoryRoot,
          "archive",
          "--format=tar",
          `--prefix=${WIDE_CAPTURE_ROOT}/`,
          "-o",
          tar,
          pin,
          "--",
          ...include,
        ],
        { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000, encoding: "utf8" },
      )
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? String(error)
      throw new Error(`git archive of the wide capture at ${pin} failed: ${stderr}`, {
        cause: error,
      })
    }
    try {
      execFileSync("tar", ["-xf", tar, "-C", absolute], {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 120_000,
        encoding: "utf8",
      })
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? String(error)
      throw new Error(`tar extraction of the wide capture at ${pin} failed: ${stderr}`, {
        cause: error,
      })
    } finally {
      rmSync(tar, { force: true })
    }
    for (const path of include)
      if (!existsSync(join(absolute, WIDE_CAPTURE_ROOT, path)))
        throw new Error(`wide capture path ${path} is absent from the archive of ${pin}`)
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
