import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import matter from "gray-matter"

/**
 * Writes apps/web/app/seo/lastmod.generated.json: one `lastModified` per
 * route the sitemap lists.
 *
 * Recorded entries are authoritative while content is unchanged: a route
 * whose source digest still matches its recorded entry keeps that entry
 * exactly, whatever Git history now says. Only a new route, or one whose
 * sources changed, is dated afresh — by the committer date (UTC) of the
 * newest commit touching any of its sources (see `readGitHistory`), or by the
 * generation time when history cannot date it (uncommitted sources, a shallow
 * clone, no Git).
 *
 * That is what makes regeneration a pull request's job without the churn: a
 * PR that edits content commits it, runs `pnpm --dir apps/web seo:lastmod`,
 * and only the entries for the routes it changed move. The squash merge that
 * later lands it on main gets a newer commit date, but the content digest is
 * unchanged, so the date recorded in the PR stands and `--check` passes on
 * main in a full-history checkout.
 */
const scriptFile = realpathSync(fileURLToPath(import.meta.url))
const scriptDir = dirname(scriptFile)
const appRoot = resolve(scriptDir, "..")
const repoRoot = resolve(appRoot, "..", "..")
const contentRoot = join(appRoot, "content")
const defaultOutputFile = join(appRoot, "app", "seo", "lastmod.generated.json")

export function normalizeRelativePath(path) {
  return path.replaceAll("\\", "/")
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

export function isDirectExecution(invokedPath, modulePath) {
  return (
    invokedPath !== undefined && realpathSync(resolve(invokedPath)) === realpathSync(modulePath)
  )
}

function filesUnder(directory, extension) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return filesUnder(path, extension)
    return entry.isFile() && path.endsWith(extension) ? [path] : []
  })
}

export function homepageSourceFiles(root = appRoot) {
  return [
    join(root, "app", "page.tsx"),
    ...filesUnder(join(root, "app", "components", "homepage"), ".tsx"),
  ]
}

function routeForDoc(source) {
  const stem = normalizeRelativePath(relative(join(contentRoot, "docs"), source)).replace(
    /\.mdx$/,
    "",
  )
  return `/docs/${stem.replace(/\/index$/, "")}`
}

function readPost(source) {
  const { data } = matter(readFileSync(source, "utf8"))
  const rawTags = Array.isArray(data.tags) ? data.tags.map((tag) => String(tag).toLowerCase()) : []
  const tags =
    data.type === "release" && !rawTags.includes("releases") ? [...rawTags, "releases"] : rawTags
  return {
    source,
    draft: data.draft === true,
    date:
      data.date instanceof Date
        ? data.date.toISOString().slice(0, 10)
        : String(data.date).slice(0, 10),
    tags,
  }
}

function sourceDigest(sources, root = repoRoot) {
  const hash = createHash("sha256")
  const sortedSources = [...sources].sort(compareCodePoints)

  for (const source of sortedSources) {
    const relativeSource = normalizeRelativePath(relative(root, source))
    const content = readFileSync(source)
    hash.update(`${relativeSource.length}:${relativeSource}:${content.length}:`)
    hash.update(content)
  }

  return hash.digest("hex")
}

function existingManifestEntries(content) {
  try {
    const manifest = JSON.parse(content)
    if (manifest.version !== 2 || typeof manifest.routes !== "object" || manifest.routes === null) {
      return new Map()
    }
    return new Map(Object.entries(manifest.routes))
  } catch {
    return new Map()
  }
}

export function recordDigest(route, lastModified, currentSourceDigest) {
  // Detect partial edits to generated records; repository review remains the trust boundary.
  return createHash("sha256")
    .update(JSON.stringify([route, lastModified, currentSourceDigest]))
    .digest("hex")
}

export function selectLastModified(
  existing,
  route,
  currentSourceDigest,
  currentLastModified,
  latestLastModified = currentLastModified,
) {
  const timestamp =
    typeof existing?.lastModified === "string" ? Date.parse(existing.lastModified) : Number.NaN
  const latestTimestamp = Date.parse(latestLastModified)
  return existing?.sourceDigest === currentSourceDigest &&
    !Number.isNaN(timestamp) &&
    !Number.isNaN(latestTimestamp) &&
    timestamp <= latestTimestamp &&
    new Date(timestamp).toISOString() === existing.lastModified &&
    existing.recordDigest === recordDigest(route, existing.lastModified, currentSourceDigest)
    ? existing.lastModified
    : currentLastModified
}

function sourcesByRouteFor(asOf) {
  const docs = filesUnder(join(contentRoot, "docs"), ".mdx")
  const posts = filesUnder(join(contentRoot, "blog"), ".mdx").map(readPost)
  const publishedPosts = posts.filter((post) => !post.draft && post.date <= asOf)

  const sourcesByRoute = new Map([
    ["/", homepageSourceFiles()],
    ["/blog", publishedPosts.map((post) => post.source)],
    ...docs.map((source) => [routeForDoc(source), [source]]),
  ])

  for (const tag of new Set(publishedPosts.flatMap((post) => post.tags))) {
    sourcesByRoute.set(
      `/blog/tags/${tag}`,
      publishedPosts.filter((post) => post.tags.includes(tag)).map((post) => post.source),
    )
  }

  return sourcesByRoute
}

/**
 * The earliest a blog listing can claim to have changed: the publication day
 * of its newest post. A post is often committed before its date, and it only
 * appears on `/blog` (and its tag pages) once that date arrives, so the commit
 * alone would date the listing too early.
 */
function publicationFloorsFor(asOf) {
  const floors = new Map()
  const published = filesUnder(join(contentRoot, "blog"), ".mdx")
    .map(readPost)
    .filter((post) => !post.draft && post.date <= asOf)
  const raise = (route, date) => {
    const current = floors.get(route)
    if (current === undefined || date > current) floors.set(route, date)
  }
  for (const post of published) {
    const day = `${post.date}T00:00:00.000Z`
    raise("/blog", day)
    for (const tag of post.tags) raise(`/blog/tags/${tag}`, day)
  }
  return floors
}

/**
 * Commit history for the manifest's sources, or `undefined` when Git cannot
 * answer (no `git` binary, not a repository).
 *
 * Consulted only for routes whose content changed or that are new: a new
 * `lastModified` is the committer date of the newest commit that touched any
 * of the route's sources.
 *
 * Two cases cannot be dated from history, and both leave the file `unknown`
 * so the caller falls back to the generation time:
 *
 * - **Dirty sources** (modified, staged or untracked). Their content is not in
 *   any commit yet, so no commit date describes it.
 * - **Shallow history.** A shallow boundary commit has its parents cut off, so
 *   Git reports it as adding every file in its tree. A depth-1 CI checkout
 *   would otherwise date every page to the tip commit. A file is only dated
 *   when its newest touching commit is a real one; if that commit is a
 *   boundary, the true date is somewhere at or before it and unknowable here.
 */
export function readGitHistory(root, relativePaths) {
  const git = (args) => {
    const result = spawnSync("git", ["-C", root, "-c", "core.quotePath=false", ...args], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    })
    return result.error || result.status !== 0 ? undefined : result.stdout
  }

  const paths = [...new Set(relativePaths)].sort(compareCodePoints)
  if (paths.length === 0) return { dates: new Map(), dirty: new Set() }

  const shallowPath = git(["rev-parse", "--git-path", "shallow"])
  if (shallowPath === undefined) return undefined
  const shallowFile = shallowPath.trim()
  const resolvedShallowFile = isAbsolute(shallowFile) ? shallowFile : resolve(root, shallowFile)
  const shallowCommits = existsSync(resolvedShallowFile)
    ? new Set(readFileSync(resolvedShallowFile, "utf8").split(/\s+/).filter(Boolean))
    : new Set()

  const log = git(["log", "--no-renames", "--format=%x1e%H %ct", "--name-only", "--", ...paths])
  const status = git([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames",
    "--",
    ...paths,
  ])
  if (log === undefined || status === undefined) return undefined

  return {
    dates: commitDatesFromLog(log, shallowCommits),
    dirty: dirtyPathsFromStatus(status),
  }
}

/** Newest touching commit per path, from `git log --format=%x1e%H %ct --name-only`. */
export function commitDatesFromLog(log, shallowCommits = new Set()) {
  const newest = new Map()
  for (const record of log.split("\x1e")) {
    const [header, ...files] = record.split("\n")
    const match = /^([0-9a-f]+) (\d+)$/.exec(header?.trim() ?? "")
    if (match === null) continue
    const [, commit, seconds] = match
    const timestamp = Number(seconds) * 1000
    const boundary = shallowCommits.has(commit)
    for (const file of files) {
      if (file === "") continue
      const current = newest.get(file)
      // Prefer a real commit over a boundary on a tie: same date either way.
      if (
        current === undefined ||
        timestamp > current.timestamp ||
        (timestamp === current.timestamp && current.boundary && !boundary)
      ) {
        newest.set(file, { timestamp, boundary })
      }
    }
  }

  const dates = new Map()
  for (const [file, { timestamp, boundary }] of newest) {
    dates.set(file, boundary ? undefined : new Date(timestamp).toISOString())
  }
  return dates
}

/** Paths reported by `git status --porcelain=v1 -z --no-renames`. */
export function dirtyPathsFromStatus(status) {
  return new Set(
    status
      .split("\0")
      .filter((entry) => entry.length > 3)
      .map((entry) => entry.slice(3)),
  )
}

/**
 * The committed date of a route, or `undefined` when any source is dirty,
 * untracked, or has no datable history.
 */
export function committedLastModified(relativeSources, history, floor) {
  if (history === undefined || relativeSources.length === 0) return undefined
  let latest
  for (const source of relativeSources) {
    if (history.dirty.has(source)) return undefined
    const date = history.dates.get(source)
    if (date === undefined) return undefined
    if (latest === undefined || date > latest) latest = date
  }
  return floor !== undefined && floor > latest ? floor : latest
}

/**
 * The manifest for `sourcesByRoute` (route → absolute source paths under
 * `root`), or `undefined` in check mode when some route cannot be dated
 * without the clock.
 *
 * Per route, in order:
 * 1. The recorded entry, verbatim, while its source digest matches and the
 *    record is well formed (`selectLastModified`). Git is not consulted: a
 *    squash merge or rebase re-dates the commits behind unchanged content,
 *    and that must not move the page's date.
 * 2. Otherwise the newest commit date of its sources, raised to the route's
 *    publication floor.
 * 3. Otherwise (dirty sources, shallow boundary, no Git) the generation time.
 *    Check mode fails instead, since that value cannot be reproduced.
 *
 * Routes absent from `sourcesByRoute` are dropped.
 */
export function generateManifest({
  root = repoRoot,
  sourcesByRoute,
  floors = new Map(),
  existingContent = "",
  check = false,
  generationTimestamp,
}) {
  const toRelative = (source) => normalizeRelativePath(relative(root, source))
  const existingEntries = existingManifestEntries(existingContent)
  const sortedRoutes = [...sourcesByRoute.entries()].sort(([left], [right]) =>
    compareCodePoints(left, right),
  )
  const digests = new Map(
    sortedRoutes.map(([route, sources]) => [route, sourceDigest(sources, root)]),
  )
  const recorded = new Map()
  const undated = []
  for (const [route] of sortedRoutes) {
    const kept = selectLastModified(
      existingEntries.get(route),
      route,
      digests.get(route),
      undefined,
      generationTimestamp,
    )
    if (kept === undefined) undated.push(route)
    else recorded.set(route, kept)
  }

  // Only routes without a usable record need history; skip Git entirely when
  // every route is unchanged.
  const history =
    undated.length === 0
      ? undefined
      : readGitHistory(
          root,
          undated.flatMap((route) => sourcesByRoute.get(route).map(toRelative)),
        )

  const entries = []
  for (const [route, sources] of sortedRoutes) {
    const digest = digests.get(route)
    const lastModified =
      recorded.get(route) ??
      committedLastModified(sources.map(toRelative), history, floors.get(route)) ??
      (check ? undefined : generationTimestamp)
    if (lastModified === undefined) return undefined
    entries.push([
      route,
      {
        lastModified,
        sourceDigest: digest,
        recordDigest: recordDigest(route, lastModified, digest),
      },
    ])
  }

  return `${JSON.stringify({ version: 2, routes: Object.fromEntries(entries) }, null, 2)}\n`
}

function manifestContent(asOf, existingContent, check, generationTimestamp) {
  return generateManifest({
    sourcesByRoute: sourcesByRouteFor(asOf),
    floors: publicationFloorsFor(asOf),
    existingContent,
    check,
    generationTimestamp,
  })
}

function asOfDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid --as-of date: ${value}`)
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid --as-of date: ${value}`)
  }
  return value
}

function optionsFor(argv) {
  let asOf = new Date().toISOString().slice(0, 10)
  let check = false
  let checkRoutes = false
  let outputFile = defaultOutputFile

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--as-of") {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("--as-of requires YYYY-MM-DD")
      asOf = asOfDate(value)
      index += 1
    } else if (argument === "--check") {
      check = true
    } else if (argument === "--check-routes") {
      checkRoutes = true
    } else if (argument === "--output") {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("--output requires a path")
      outputFile = resolve(value)
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }

  return { asOf, check, checkRoutes, outputFile }
}

/**
 * Routes the manifest covers but should not, or should cover but does not.
 *
 * The cheap gate a pull request cannot skip. A stale timestamp only dates a
 * page wrong, but a route the manifest has never seen has no timestamp at
 * all, and `requireValidLastModified` throws on it — so adding or removing a
 * page without regenerating breaks the site build.
 */
export function routeCoverageDrift(asOf, existingContent) {
  const expected = [...sourcesByRouteFor(asOf).keys()].sort(compareCodePoints)
  const covered = [...existingManifestEntries(existingContent).keys()].sort(compareCodePoints)
  const coveredSet = new Set(covered)
  const expectedSet = new Set(expected)

  return {
    missing: expected.filter((route) => !coveredSet.has(route)),
    unexpected: covered.filter((route) => !expectedSet.has(route)),
  }
}

function main(argv) {
  const { asOf, check, checkRoutes, outputFile } = optionsFor(argv)
  let existing = ""
  try {
    existing = readFileSync(outputFile, "utf8")
  } catch {
    // A missing manifest has no timestamps to preserve.
  }

  if (checkRoutes) {
    const { missing, unexpected } = routeCoverageDrift(asOf, existing)
    if (missing.length > 0 || unexpected.length > 0) {
      if (missing.length > 0) console.error(`SEO manifest is missing routes: ${missing.join(", ")}`)
      if (unexpected.length > 0) {
        console.error(`SEO manifest covers removed routes: ${unexpected.join(", ")}`)
      }
      console.error("Regenerate with pnpm --dir apps/web seo:lastmod")
      process.exitCode = 1
    }
    return
  }

  const content = manifestContent(asOf, existing, check, new Date().toISOString())

  if (check) {
    if (content === undefined || existing !== content) {
      console.error(
        `SEO last-modified manifest is stale: regenerate with pnpm --dir apps/web seo:lastmod --as-of ${asOf}`,
      )
      process.exitCode = 1
    }
    return
  }

  mkdirSync(dirname(outputFile), { recursive: true })
  if (content === undefined) throw new Error("Cannot generate an empty SEO manifest")
  writeFileSync(outputFile, content)
}

if (isDirectExecution(process.argv[1], scriptFile)) {
  main(process.argv.slice(2))
}
