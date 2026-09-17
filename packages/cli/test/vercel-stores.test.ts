import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { discoverRoutes } from "@b4run/core/node"
import { afterEach, describe, expect, test } from "vitest"

import { emitWebRuntimeArtifacts } from "../src/lib/build/targets/web-runtime.js"
import {
  driveEmittedStores,
  NO_PROXY_RUNTIME_ENV_STUB,
  POSTGRES_STORAGE_STUB,
} from "./helpers/emitted-stores.js"

// ---------------------------------------------------------------------------
// The Vercel variant of the emitted `stores.mjs` — driver selection.
//
// A Vercel function is a Node process with real TCP, so unlike workerd it can
// reach a plain Postgres directly. The generated factory therefore opens a
// pooled `pg` connection for any DATABASE_URL that is not a Neon host (or when
// B4_PG_DRIVER=pg says so), and keeps `@neondatabase/serverless` for Neon and
// for the local wsproxy lane. Asserted by RUNNING the emitted file against
// driver doubles, never by grepping it: a text match can be satisfied by a
// doc comment. (cacheplane/b4run#690)
// ---------------------------------------------------------------------------

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, maxRetries: 5, recursive: true })),
  )
})

async function createFixtureApp(targets: readonly string[] = ["vercel"]): Promise<string> {
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "b4-cli-vercel-stores-")))
  tempDirs.push(appRoot)
  const files: Record<string, string> = {
    "b4.config.ts": `export default { build: { targets: ${JSON.stringify(targets)} } }\n`,
    "package.json": `${JSON.stringify({
      dependencies: {
        "@b4run/cli": "workspace:*",
        "@b4run/postgres-storage": "workspace:*",
        "@neondatabase/serverless": "^1.1.0",
        hono: "^4.12.28",
      },
      name: "vercel-stores-fixture",
      type: "module",
    })}\n`,
    "src/app/probe/index.ts":
      'export async function workflow() { return { message: "deterministic" } }\n',
  }
  await Promise.all(
    Object.entries(files).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )
  return appRoot
}

/** Emit the shared runtime files for `targetName` and return the directory holding them. */
async function emitRuntime(appRoot: string, targetName: "hono" | "vercel"): Promise<string> {
  const manifest = await discoverRoutes({ appRoot })
  const outputDir = join(appRoot, ".vercel", ".b4-vercel-test", "runtime")
  await emitWebRuntimeArtifacts(
    { appRoot, buildDir: join(appRoot, ".b4", "build"), manifest },
    { outputDir, targetName },
  )
  return outputDir
}

/** Both drivers' pools, so a test sees which one a request landed on. */
const DRIVER_REPORT = {
  report: "{ neon: poolConnections(), pg: pgPoolConnections(), requestErrors }",
  reportImports: 'import { pgPoolConnections } from "@b4run/postgres-storage/node"',
} as const

const NEON_URL = "postgres://u:p@ep-quiet-sea-123456.us-east-2.aws.neon.tech/neondb?sslmode=require"
const LOCAL_URL = "postgres://u:p@127.0.0.1:5432/app"

describe("vercel target — stores.mjs driver selection", () => {
  test("a non-Neon DATABASE_URL opens a pooled pg connection with no proxy", async () => {
    const appRoot = await createFixtureApp()
    const runtimeDir = await emitRuntime(appRoot, "vercel")

    const observed = await driveEmittedStores(appRoot, runtimeDir, [{ DATABASE_URL: LOCAL_URL }], {
      ...DRIVER_REPORT,
      cliStub: NO_PROXY_RUNTIME_ENV_STUB,
    })

    // The pg pool is built, used, and ENDED on dispose — it is per request
    // exactly like the neon one — and no neon pool was opened at all.
    expect(observed).toEqual({
      neon: [],
      pg: [{ connectionString: LOCAL_URL, ended: true }],
      requestErrors: [],
    })
  })

  test("a Neon DATABASE_URL keeps the neon WebSocket driver, secure, with no proxy", async () => {
    const appRoot = await createFixtureApp()
    const runtimeDir = await emitRuntime(appRoot, "vercel")

    const observed = await driveEmittedStores(appRoot, runtimeDir, [{ DATABASE_URL: NEON_URL }], {
      ...DRIVER_REPORT,
      cliStub: NO_PROXY_RUNTIME_ENV_STUB,
    })

    expect(observed).toEqual({
      neon: [{ connectionString: NEON_URL, useSecureWebSocket: true, wsProxy: null }],
      pg: [],
      requestErrors: [],
    })
  })

  test("B4_PG_WS_PROXY selects the neon driver for a local host and accepts a ws:// prefix", async () => {
    const appRoot = await createFixtureApp()
    const runtimeDir = await emitRuntime(appRoot, "vercel")

    const observed = await driveEmittedStores(
      appRoot,
      runtimeDir,
      [
        { B4_PG_WS_PROXY: "ws://127.0.0.1:54321", DATABASE_URL: LOCAL_URL },
        { B4_PG_WS_PROXY: "127.0.0.1:54321", DATABASE_URL: LOCAL_URL },
      ],
      { ...DRIVER_REPORT, cliStub: NO_PROXY_RUNTIME_ENV_STUB },
    )

    // Both spellings reach the driver as the bare host:port it prefixes itself.
    expect(observed).toEqual({
      neon: [
        {
          connectionString: LOCAL_URL,
          useSecureWebSocket: false,
          wsProxy: "127.0.0.1:54321/v1?address=b4-pg:5432",
        },
        {
          connectionString: LOCAL_URL,
          useSecureWebSocket: false,
          wsProxy: "127.0.0.1:54321/v1?address=b4-pg:5432",
        },
      ],
      pg: [],
      requestErrors: [],
    })
  })

  test("B4_PG_DRIVER overrides host detection in both directions, per request", async () => {
    const appRoot = await createFixtureApp()
    const runtimeDir = await emitRuntime(appRoot, "vercel")

    const observed = await driveEmittedStores(
      appRoot,
      runtimeDir,
      [
        { B4_PG_DRIVER: "pg", DATABASE_URL: NEON_URL },
        { B4_PG_DRIVER: "neon", DATABASE_URL: LOCAL_URL },
      ],
      { ...DRIVER_REPORT, cliStub: NO_PROXY_RUNTIME_ENV_STUB },
    )

    expect(observed).toEqual({
      neon: [{ connectionString: LOCAL_URL, useSecureWebSocket: true, wsProxy: null }],
      pg: [{ connectionString: NEON_URL, ended: true }],
      requestErrors: [],
    })
  })

  test("a malformed B4_PG_WS_PROXY or B4_PG_DRIVER fails the request with a message naming the variable", async () => {
    const appRoot = await createFixtureApp()
    const runtimeDir = await emitRuntime(appRoot, "vercel")

    const observed = await driveEmittedStores(
      appRoot,
      runtimeDir,
      [
        { B4_PG_WS_PROXY: "http://127.0.0.1:54321", DATABASE_URL: LOCAL_URL },
        { B4_PG_DRIVER: "mysql", DATABASE_URL: LOCAL_URL },
      ],
      { ...DRIVER_REPORT, cliStub: NO_PROXY_RUNTIME_ENV_STUB, tolerateRequestFailures: true },
    )

    // Rejected BEFORE any pool is opened, so nothing is left to dispose.
    expect(observed).toMatchObject({ neon: [], pg: [] })
    const { requestErrors } = observed as { requestErrors: string[] }
    expect(requestErrors).toHaveLength(2)
    expect(requestErrors[0]).toMatch(/B4_PG_WS_PROXY must be host:port.*ws:\/\/ or wss:\/\//)
    expect(requestErrors[1]).toMatch(/B4_PG_DRIVER must be "neon" or "pg"/)
  })

  test("the pg path still runs the cold-start migration pass once per isolate", async () => {
    const appRoot = await createFixtureApp()
    const runtimeDir = await emitRuntime(appRoot, "vercel")

    const observed = await driveEmittedStores(
      appRoot,
      runtimeDir,
      [{ DATABASE_URL: LOCAL_URL }, { DATABASE_URL: LOCAL_URL }],
      {
        cliStub: NO_PROXY_RUNTIME_ENV_STUB,
        report: "{ readyCalls: readyCalls.length }",
        reportImports: 'import { readyCalls } from "@b4run/postgres-storage"',
        storageStub: `export const readyCalls = []
const store = { ready: async () => { readyCalls.push(1) } }
export const createPostgresPermissionsStore = () => store
export const createPostgresThreadsStore = () => store
export const postgresCheckpointer = () => store
`,
      },
    )

    // Three stores migrate on the first request; the second skips the pass.
    expect(observed).toEqual({ readyCalls: 3 })
  })

  test("only the vercel variant imports the pg pool builder; the hono variant stays edge-linkable", async () => {
    const appRoot = await createFixtureApp(["hono"])
    const vercelDir = await emitRuntime(appRoot, "vercel")
    const vercelStores = await readFile(join(vercelDir, "stores.mjs"), "utf8")
    expect(vercelStores).toContain('from "@b4run/postgres-storage/node"')

    const honoDir = await emitRuntime(appRoot, "hono")
    const honoStores = await readFile(join(honoDir, "stores.mjs"), "utf8")
    // `@b4run/postgres-storage/node` has a value import of `pg`, which pulls
    // net/tls/dns into the graph — exactly what the hono bundle must not link.
    expect(honoStores).not.toContain("@b4run/postgres-storage/node")
    expect(honoStores).not.toContain("createPostgresPool")

    // The stub-driven hono variant is still the neon-only factory.
    const observed = await driveEmittedStores(appRoot, honoDir, [{ DATABASE_URL: LOCAL_URL }], {
      ...DRIVER_REPORT,
      cliStub: NO_PROXY_RUNTIME_ENV_STUB,
      storageStub: POSTGRES_STORAGE_STUB,
    })
    expect(observed).toEqual({
      neon: [{ connectionString: LOCAL_URL, useSecureWebSocket: true, wsProxy: null }],
      pg: [],
      requestErrors: [],
    })
  })
})
