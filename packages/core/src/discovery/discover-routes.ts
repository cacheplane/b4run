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

  await walkRouteTree(routesDir, routesDir, discovered)

  return discovered
}

async function walkRouteTree(
  routesDir: string,
  currentDir: string,
  discovered: RouteDefinition[],
): Promise<void> {
  const routeEntry = await readRouteEntry(routesDir, currentDir)

  if (routeEntry) {
    discovered.push(routeEntry)
  }

  const entries = (await readdir(currentDir, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )

  for (const entry of entries) {
    if (!entry.isDirectory() || isPrivateSegment(entry.name)) {
      continue
    }

    await walkRouteTree(routesDir, join(currentDir, entry.name), discovered)
  }
}

async function readRouteEntry(
  routesDir: string,
  routeDir: string,
): Promise<RouteDefinition | null> {
  const entries = await readdir(routeDir, { withFileTypes: true }).catch(() => null)

  if (!entries) {
    return null
  }

  const hasIndex = entries.some((entry) => entry.isFile() && entry.name === INDEX_FILE)

  if (!hasIndex) {
    return null
  }

  const indexFile = resolve(routeDir, INDEX_FILE)
  const routeExports = await loadRouteExports(indexFile)
  const kind = inferRouteKind(routeExports)

  if (!kind) {
    // A directory under the routes dir with an index.ts is a route by
    // construction; one whose module exports nothing B4.run recognises is a
    // defect to name, not a directory to skip (#685: the CommonJS interop shape
    // used to be dropped here and reported as "0 routes discovered").
    throw new B4AppError(
      explainUnrecognisedRouteExports(
        indexFile,
        routeExports,
        await findNearestPackageJson(routeDir),
      ),
      "B4_E1007",
    )
  }

  const routeSegments = relative(routesDir, routeDir)
    .split(sep)
    .filter(Boolean)
    .filter((segment) => !isRouteGroupSegment(segment))

  return {
    id: toPathname(routeSegments),
    pathname: toPathname(routeSegments),
    kind,
    entryFile: indexFile,
    routeDir,
    segments: toRouteSegments(routeSegments),
  }
}

function inferRouteKind(routeExports: RouteExports): RouteKind | null {
  // Check default export for B4Agent descriptor (preferred path)
  if ("default" in routeExports && isB4Agent(routeExports.default)) {
    return "agent"
  }

  const hasAgent = "agent" in routeExports && routeExports.agent !== undefined
  const hasChain = "chain" in routeExports && routeExports.chain !== undefined
  const hasGraph = "graph" in routeExports && routeExports.graph !== undefined
  const hasWorkflow = "workflow" in routeExports && routeExports.workflow !== undefined

  const count = [hasAgent, hasChain, hasGraph, hasWorkflow].filter(Boolean).length

  if (count > 1) {
    throw new Error(
      `Route index.ts must export exactly one of "agent", "workflow", "graph", or "chain"`,
    )
  }

  if (hasAgent) {
    return "agent"
  }

  if (hasChain) {
    return "chain"
  }

  if (hasGraph) {
    return "graph"
  }

  if (hasWorkflow) {
    return "workflow"
  }

  return null
}

const RECOGNISED_EXPORTS =
  'a default export of `agent(...)`, or exactly one of "agent", "workflow", "graph", or "chain"'

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
