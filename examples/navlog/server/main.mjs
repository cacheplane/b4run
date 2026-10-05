// Production entry for the navlog server. Plain ESM so the Docker image needs
// no compile step. Mirrors the generated `.b4/build/server.mjs` (manifest +
// workspace), then adds what a public deployment needs:
//   - Postgres stores when DATABASE_URL is set (checkpointer, threads, permissions);
//   - an internal-token guard on every request but /healthz when B4_INTERNAL_TOKEN is set.
// With neither variable set it behaves like `b4 start`. Run `b4 build` first.
import { timingSafeEqual } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { loadStaticModules, serve } from "@b4run/cli"
import {
  createPostgresPermissionsStore,
  createPostgresPool,
  createPostgresThreadsStore,
  postgresCheckpointer,
} from "@b4run/postgres-storage/node"

const appRoot = dirname(fileURLToPath(import.meta.url))

// modules.mjs statically imports the app's TypeScript sources, so it is loaded
// through loadStaticModules, which registers the TS loader first.
const loadedModules = await loadStaticModules(new URL("./.b4/build/modules.mjs", import.meta.url))
const workspaceUrl = new URL("./.b4/build/workspace.json", import.meta.url)
if ((await stat(workspaceUrl)).size > 100 * 1024 * 1024) {
  throw new Error("Workspace artifact exceeds size limit")
}
const modules = { ...loadedModules, workspace: JSON.parse(await readFile(workspaceUrl, "utf8")) }

const token = process.env.B4_INTERNAL_TOKEN || undefined
const databaseUrl = process.env.DATABASE_URL || undefined

// Fail closed. A deployment (a Postgres store, or Railway) without the token
// would serve every runtime route to anyone who finds its URL, so it refuses to
// boot unless the operator says, explicitly, that an unguarded server is meant.
const onRailway = [
  "RAILWAY_ENVIRONMENT",
  "RAILWAY_ENVIRONMENT_NAME",
  "RAILWAY_ENVIRONMENT_ID",
].some((name) => Boolean(process.env[name]))
const deployed = databaseUrl !== undefined || onRailway
if (token === undefined && deployed && process.env.B4_ALLOW_UNGUARDED !== "1") {
  console.error(
    "Refusing to boot: B4_INTERNAL_TOKEN is not set, but this looks like a deployment " +
      "(DATABASE_URL or a RAILWAY_ENVIRONMENT variable is set). Set B4_INTERNAL_TOKEN to the secret the " +
      "web proxy sends (openssl rand -base64 32), or B4_ALLOW_UNGUARDED=1 to serve unguarded.",
  )
  process.exit(1)
}
if (token !== undefined && token.length < 32) {
  console.error(
    "Refusing to boot: B4_INTERNAL_TOKEN must be at least 32 characters (openssl rand -base64 32).",
  )
  process.exit(1)
}

const handle = await serve({
  appRoot,
  host: process.env.HOST || "0.0.0.0",
  port: listenPort(process.env.PORT),
  modules,
  // src/thread-access.ts is committed, so a manifest without the policy is a
  // stale or broken build: boot fails rather than serve thread endpoints open.
  threadAccessExpected: true,
  permissionsMode: "boot",
  ...(databaseUrl ? postgresStores(databaseUrl) : {}),
  ...(token ? { guard: tokenGuard(token) } : {}),
  onListening: (url) =>
    console.log(
      `B4.run navlog listening on ${url}${token ? " (guarded)" : ""}${databaseUrl ? " (postgres)" : " (sqlite)"}`,
    ),
})

// serve() handles SIGINT/SIGTERM itself (ordered shutdown); nothing else to do.
void handle

/** PORT as `b4 start` reads it: empty or non-numeric means the default 8000. */
function listenPort(value) {
  const trimmed = (value ?? "").trim()
  if (trimmed === "") return 8000
  const parsed = Number(trimmed)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 8000
}

function postgresStores(connectionString) {
  // One pool for the three stores; the pool carries its own 'error' listener.
  const pool = createPostgresPool({ connectionString })
  const schema = process.env.B4_PG_SCHEMA || "public"
  const tablePrefix = process.env.B4_PG_TABLE_PREFIX || "b4"
  return {
    checkpointer: postgresCheckpointer({ pool, schema, tablePrefix }),
    threadsStore: createPostgresThreadsStore({ pool, schema, tablePrefix }),
    permissionsStore: createPostgresPermissionsStore({ pool, schema, tablePrefix }),
  }
}

/**
 * Everything but the health check must carry the token the web proxy injects.
 * The pathname is compared exactly after parsing, never by prefix on the raw
 * url: the runtime routes on the normalized path.
 */
function tokenGuard(secret) {
  const expected = Buffer.from(secret)
  return (request, response) => {
    let pathname = "/"
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname
    } catch {
      // An unparseable target is not the health check; it needs the token.
    }
    if (pathname === "/healthz") return false
    const presented = request.headers["x-internal-token"]
    if (typeof presented === "string") {
      const actual = Buffer.from(presented)
      if (actual.length === expected.length && timingSafeEqual(actual, expected)) return false
    }
    response.writeHead(401, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: "unauthorized" }))
    return true
  }
}
