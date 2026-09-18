import { constants } from "node:fs"
import { access, readdir } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import type { RouteKind } from "@b4run/sdk"
import { isB4Agent } from "@b4run/sdk"
import { registerTsxLoader } from "../config-node.js"
import type { DiscoverRoutesOptions, RouteDefinition, RouteManifest } from "../types.js"
import { B4AppError } from "./b4-app-error.js"
import { findB4App } from "./find-b4-app.js"
import { isPrivateSegment, isRouteGroupSegment, toRouteSegments } from "./route-segments.js"

const INDEX_FILE = "index.ts"
const PACKAGE_JSON_FILE = "package.json"

export async function discoverRoutes(options: DiscoverRoutesOptions = {}): Promise<RouteManifest> {
  const app = await findB4App(options)
  const routes = validateRouteCollisions(await collectRouteDefinitions(app.routesDir))

  return {
    appRoot: app.appRoot,
    routes: routes.sort((left, right) => left.pathname.localeCompare(right.pathname)),
  }
}

async function collectRouteDefinitions(routesDir: string): Promise<RouteDefinition[]> {
  const discovered: RouteDefinition[] = []
  const unrecognised: UnrecognisedRouteEntry[] = []
  const multiKind: MultiKindRouteEntry[] = []

  await walkRouteTree(routesDir, routesDir, discovered, unrecognised, multiKind)

  // Batched the way `b4 check`'s other app-wide gates are (the edge-capability
  // report, the marker-file limits): every miswired route entry is named in one
  // run, instead of the user fixing one and re-running to meet the next.
  //
  // The two defects carry different codes, so they cannot share one error. When
  // an app has both, the unrecognised entries are reported first and the message
  // says how many multi-kind entries are queued behind them, so the second round
  // is never a surprise.
  if (unrecognised.length > 0) {
    throw new B4AppError(
      explainUnrecognisedRouteEntries(unrecognised, multiKind.length),
      "B4_E1007",
    )
  }

  if (multiKind.length > 0) {
    throw new B4AppError(explainMultiKindRouteEntries(multiKind), "B4_E1008")
  }

  return discovered
}

async function walkRouteTree(
  routesDir: string,
  currentDir: string,
  discovered: RouteDefinition[],
  unrecognised: UnrecognisedRouteEntry[],
  multiKind: MultiKindRouteEntry[],
): Promise<void> {
  const scan = await readRouteEntry(routesDir, currentDir)

  if (scan.route) {
    discovered.push(scan.route)
  }

  if (scan.unrecognised) {
    unrecognised.push(scan.unrecognised)
  }

  if (scan.multiKind) {
    multiKind.push(scan.multiKind)
  }

  const entries = (await readdir(currentDir, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )

  for (const entry of entries) {
    if (!entry.isDirectory() || isPrivateSegment(entry.name)) {
      continue
    }

    await walkRouteTree(
      routesDir,
      join(currentDir, entry.name),
      discovered,
      unrecognised,
      multiKind,
    )
  }
}

/**
 * One route entry whose exports B4.run cannot classify, held rather than thrown
 * so the walk finishes and every offending entry can be reported together.
 */
interface UnrecognisedRouteEntry {
  readonly indexFile: string
  readonly routeExports: RouteExports
  readonly nearestPackageJson: string | undefined
}

/**
 * One route entry that exports more than one route kind, held rather than thrown
 * for the same reason as `UnrecognisedRouteEntry`.
 */
interface MultiKindRouteEntry {
  readonly indexFile: string
  /** The route kinds the module exported, in the order the message lists them. */
  readonly kinds: readonly RouteKind[]
}

/** What one directory contributed to the walk: a route, a defect, or neither. */
interface RouteEntryScan {
  readonly route?: RouteDefinition
  readonly unrecognised?: UnrecognisedRouteEntry
  readonly multiKind?: MultiKindRouteEntry
}

const NO_ROUTE_ENTRY: RouteEntryScan = {}

async function readRouteEntry(routesDir: string, routeDir: string): Promise<RouteEntryScan> {
  const entries = await readdir(routeDir, { withFileTypes: true }).catch(() => null)

  if (!entries) {
    return NO_ROUTE_ENTRY
  }

  const hasIndex = entries.some((entry) => entry.isFile() && entry.name === INDEX_FILE)

  if (!hasIndex) {
    return NO_ROUTE_ENTRY
  }

  const indexFile = resolve(routeDir, INDEX_FILE)
  const routeExports = await loadRouteExports(indexFile)
  const classification = classifyRouteExports(routeExports)

  if (classification.outcome === "multiple") {
    return { multiKind: { indexFile, kinds: classification.kinds } }
  }

  if (classification.outcome === "unrecognised") {
    // A directory under the routes dir with an index.ts is a route by
    // construction; one whose module exports nothing B4.run recognises is a
    // defect to name, not a directory to skip (#685: the CommonJS interop shape
    // used to be dropped here and reported as "0 routes discovered"). Recorded
    // instead of thrown so one run names every offending entry.
    return {
      unrecognised: {
        indexFile,
        routeExports,
        nearestPackageJson: await findNearestPackageJson(routeDir),
      },
    }
  }

  const routeSegments = relative(routesDir, routeDir)
    .split(sep)
    .filter(Boolean)
    .filter((segment) => !isRouteGroupSegment(segment))

  return {
    route: {
      id: toPathname(routeSegments),
      pathname: toPathname(routeSegments),
      kind: classification.kind,
      entryFile: indexFile,
      routeDir,
      segments: toRouteSegments(routeSegments),
    },
  }
}

/**
 * What a route module's exports say it is. Returns instead of throwing on the
 * multi-kind defect so the walk can collect every offending entry — the throw
 * belongs to `collectRouteDefinitions`, which sees the whole app.
 */
type RouteExportsClassification =
  | { readonly outcome: "kind"; readonly kind: RouteKind }
  | { readonly outcome: "multiple"; readonly kinds: readonly RouteKind[] }
  | { readonly outcome: "unrecognised" }

/** Declaration order, so a message lists the kinds the way the docs name them. */
const ROUTE_KINDS = ["agent", "workflow", "graph", "chain"] as const satisfies readonly RouteKind[]

function classifyRouteExports(routeExports: RouteExports): RouteExportsClassification {
  // Check default export for B4Agent descriptor (preferred path)
  if ("default" in routeExports && isB4Agent(routeExports.default)) {
    return { outcome: "kind", kind: "agent" }
  }

  const exported = ROUTE_KINDS.filter(
    (kind) => kind in routeExports && routeExports[kind] !== undefined,
  )

  if (exported.length > 1) {
    return { outcome: "multiple", kinds: exported }
  }

  const [only] = exported

  return only ? { outcome: "kind", kind: only } : { outcome: "unrecognised" }
}

const RECOGNISED_KINDS = 'exactly one of "agent", "workflow", "graph", or "chain"'

const RECOGNISED_EXPORTS = `a default export of \`agent(...)\`, or ${RECOGNISED_KINDS}`

/**
 * The message for a route `index.ts` whose exports B4.run cannot classify.
 * Pure so the CommonJS branch can be unit-tested without the tsx loader:
 * under vitest the route import goes through vite-node, which never produces
 * the interop shape.
 *
 * The interop shape is what Node's ESM loader returns for a CommonJS module:
 * a `"module.exports"` namespace key (Node ≥ 22) and/or `default` set to the
 * `{ __esModule: true, default }` object a transpiler emits for
 * `export default`. That means the nearest package.json to the file does not
 * set `"type": "module"` — the app root is checked up front, so reaching this
 * branch usually means a nested package.json flipped the format for one route.
 */
export function explainUnrecognisedRouteExports(
  indexFile: string,
  routeExports: object,
  nearestPackageJson: string | undefined,
): string {
  const names = Object.keys(routeExports)
  const found = names.length === 0 ? "the module has no exports" : `found: ${names.join(", ")}`
  const lead = `Route entry ${indexFile} has no recognisable export (${found}).\nA route index.ts must export ${RECOGNISED_EXPORTS}.`

  if (looksLikeCommonJsInterop(routeExports)) {
    const where = nearestPackageJson
      ? `the nearest package.json (${nearestPackageJson})`
      : "the nearest package.json"
    return (
      `${lead}\n` +
      `Likely cause: this file was loaded as CommonJS because ${where} does not set "type": "module", ` +
      "so its exports arrived wrapped in the ESM/CommonJS interop object. " +
      'Add "type": "module" to that package.json.'
    )
  }

  return `${lead}\nIf this directory is not a route, prefix its name with "_" to keep it out of route discovery.`
}

/**
 * The B4_E1007 message for every unrecognised route entry one walk found. A
 * single entry keeps its own message verbatim; several are bulleted with their
 * per-entry explanations indented underneath, in walk order (sorted, so the
 * listing is stable).
 */
function explainUnrecognisedRouteEntries(
  entries: readonly UnrecognisedRouteEntry[],
  queuedMultiKindCount: number,
): string {
  const explanations = entries.map((entry) =>
    explainUnrecognisedRouteExports(entry.indexFile, entry.routeExports, entry.nearestPackageJson),
  )

  const [only] = explanations
  const body =
    explanations.length === 1 && only !== undefined
      ? only
      : [
          `${explanations.length} route entries have no recognisable export:`,
          ...explanations.map((explanation) => bullet(explanation)),
        ].join("\n")

  if (queuedMultiKindCount === 0) {
    return body
  }

  // B4_E1008 is a different code and cannot ride along in this error, so say it
  // is waiting rather than letting the next run look like a new problem.
  const subject =
    queuedMultiKindCount === 1
      ? "1 route entry exports"
      : `${queuedMultiKindCount} route entries export`
  return (
    `${body}\n` +
    `Also: ${subject} more than one route kind, ` +
    "reported as B4_E1008 once the above are fixed."
  )
}

/**
 * The B4_E1008 message for every route entry that exported more than one route
 * kind. Shaped like the B4_E1007 message: a single entry stands alone, several
 * are bulleted. Keeps the wording `must export exactly one of ...`, which the
 * runtime's boundary-error classifier and several CLI tests match on.
 */
function explainMultiKindRouteEntries(entries: readonly MultiKindRouteEntry[]): string {
  const explanations = entries.map(
    (entry) =>
      `Route entry ${entry.indexFile} must export ${RECOGNISED_KINDS} (found: ${entry.kinds.join(", ")}).\n` +
      "Keep the one this route should run and remove the others, or move them into separate route directories.",
  )

  const [only] = explanations

  if (explanations.length === 1 && only !== undefined) {
    return only
  }

  return [
    `${explanations.length} route entries export more than one route kind:`,
    ...explanations.map((explanation) => bullet(explanation)),
  ].join("\n")
}

/** One listing entry: `• ` on the first line, continuation lines indented under it. */
function bullet(explanation: string): string {
  return `  • ${explanation.split("\n").join("\n    ")}`
}

function looksLikeCommonJsInterop(routeExports: object): boolean {
  if ("module.exports" in routeExports) {
    return true
  }

  const defaultExport = (routeExports as { readonly default?: unknown }).default
  return (
    typeof defaultExport === "object" &&
    defaultExport !== null &&
    (defaultExport as { readonly __esModule?: unknown }).__esModule === true
  )
}

async function findNearestPackageJson(fromDir: string): Promise<string | undefined> {
  let currentDir = resolve(fromDir)

  while (true) {
    const candidate = join(currentDir, PACKAGE_JSON_FILE)
    try {
      await access(candidate, constants.F_OK)
      return candidate
    } catch {
      // keep walking up
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      return undefined
    }
    currentDir = parentDir
  }
}

interface RouteExports {
  readonly default?: unknown
  readonly agent?: unknown
  readonly chain?: unknown
  readonly graph?: unknown
  readonly workflow?: unknown
}

async function loadRouteExports(indexFile: string): Promise<RouteExports> {
  await registerTsxLoader()
  try {
    return (await import(pathToFileURL(indexFile).href)) as RouteExports
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`Failed to load route at ${indexFile}: ${reason}`, { cause })
  }
}

function validateRouteCollisions(routes: readonly RouteDefinition[]): RouteDefinition[] {
  const byPathname = new Map<string, RouteDefinition>()

  for (const route of routes) {
    const existingRoute = byPathname.get(route.pathname)

    if (existingRoute) {
      throw new Error(
        `Duplicate B4.run route pathname "${route.pathname}" detected at ${existingRoute.routeDir} and ${route.routeDir}`,
      )
    }

    byPathname.set(route.pathname, route)
  }

  return [...routes]
}

function toPathname(routeSegments: readonly string[]): string {
  if (routeSegments.length === 0) {
    return "/"
  }

  return `/${routeSegments.join("/")}`
}
