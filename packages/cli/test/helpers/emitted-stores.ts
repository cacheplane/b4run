import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

// ---------------------------------------------------------------------------
// Stubs for what an emitted `stores.mjs` / `app.mjs` imports, so the REAL
// emitted file can be executed in a plain Node child process and asked what it
// did — which driver it opened, with which options, through which proxy.
//
// Shared by the hono and vercel suites: the two targets emit the same store
// factory from one template, so the same doubles must drive both.
// ---------------------------------------------------------------------------

const cliPackageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

/** `@b4run/postgres-storage`'s main entry: three stores whose `ready()` is a no-op. */
export const POSTGRES_STORAGE_STUB = `const store = { ready: async () => {} }
export const createPostgresPermissionsStore = () => store
export const createPostgresThreadsStore = () => store
export const postgresCheckpointer = () => store
`

/**
 * The same store trio, but whose FIRST `ready()` rejects — a failed cold
 * start. Counts every call so a later request's migration pass is visible.
 */
export const FAILING_READY_STORAGE_STUB = `export const readyCalls = []
let failNext = true
const store = {
  ready: async () => {
    readyCalls.push(1)
    if (!failNext) return
    failNext = false
    throw new Error("cold start failed")
  },
}
export const createPostgresPermissionsStore = () => store
export const createPostgresThreadsStore = () => store
export const postgresCheckpointer = () => store
`

/**
 * `@b4run/postgres-storage/node`: the `pg` pool builder the Vercel variant of
 * stores.mjs uses for a non-Neon DATABASE_URL. Records every pool it built so a
 * test can see which driver a request ended up on; `end()` resolves so
 * `dispose()` works.
 */
export const POSTGRES_STORAGE_NODE_STUB = `export const pgPools = []
export function createPostgresPool(config) {
  const pool = {
    config,
    ended: false,
    end() {
      this.ended = true
      return Promise.resolve()
    },
  }
  pgPools.push(pool)
  return pool
}
/** What each pg pool was asked to connect to, in order. */
export const pgPoolConnections = () =>
  pgPools.map((pool) => ({ connectionString: pool.config.connectionString ?? null, ended: pool.ended }))
`

/**
 * `@neondatabase/serverless`, stubbed at the four seams the emitted stores.mjs
 * actually uses.
 *
 * `Client` carries the driver's REAL per-instance defaults (TLS on), and
 * `Pool` reproduces the ordering that makes the per-instance override work at
 * all: the real Pool overwrites `this.Client` with its own class inside its
 * constructor, and stores.mjs assigns over it afterwards. Clients are built
 * lazily here exactly as the real Pool builds them — `new this.Client(this.options)`
 * — which is why the pools, not the clients, are what gets recorded.
 *
 * `on` is here because the real Pool is an EventEmitter (the driver vendors
 * pg-pool and the `events` polyfill) and stores.mjs registers an 'error'
 * listener on it. A double without it would fail the emitted code for a
 * reason the real driver never would.
 */
export const NEON_STUB = `export class Client {
  constructor(config) {
    this.config = config
    this.neonConfig = { pipelineConnect: "password", pipelineTLS: false, useSecureWebSocket: true }
  }
}
/** Every pool built, in order. */
export const pools = []
export const defaultTypeParserCalls = []
export const types = {
  getTypeParser(id, format = "text") {
    defaultTypeParserCalls.push([id, format])
    return (value) => "default:" + id + ":" + format + ":" + value
  },
}
export class Pool {
  constructor(options) {
    this.options = options
    this.Client = Client
    /** Events stores.mjs subscribed to, so a test can assert the 'error' listener exists. */
    this.handlers = {}
    pools.push(this)
  }
  on(event, listener) {
    ;(this.handlers[event] ??= []).push(listener)
    return this
  }
  end() {
    return Promise.resolve()
  }
}
/** The events each pool has a listener for, in order. */
export const poolHandlers = () => pools.map((pool) => Object.keys(pool.handlers))
/** What the real Pool does when it opens a connection, per pool, in order. */
export const poolConnections = () =>
  pools.map((pool) => {
    const client = new pool.Client(pool.options)
    return {
      connectionString: pool.options.connectionString ?? null,
      useSecureWebSocket: client.neonConfig.useSecureWebSocket,
      wsProxy: client.neonConfig.wsProxy?.("b4-pg", 5432) ?? null,
    }
  })
export const poolTypeParserReport = () => {
  const customTypes = pools[0]?.options.types
  const byteaParser = customTypes?.getTypeParser(17, "text")
  const bytea = byteaParser("\\\\x0001ff")
  const invalidBytea = ["\\\\x0", "\\\\xgg", "legacy-bytea"].map((value) => {
    try {
      byteaParser(value)
      return "accepted"
    } catch {
      return "rejected"
    }
  })
  return {
    binaryBytea: customTypes?.getTypeParser(17, "binary")("raw"),
    bytea: Array.from(bytea),
    byteaConstructor: bytea.constructor.name,
    defaultTypeParserCalls,
    distinctPoolTypeObjects:
      new Set(pools.map((pool) => pool.options.types)).size === pools.length,
    integer: customTypes?.getTypeParser(23, "text")("42"),
    invalidBytea,
  }
}
`

/**
 * A minimal `hono` stub with the shape the emitted entry uses. Mirrors real
 * Hono: `app.fetch(request, env, ctx)` is the Workers entry signature, `c.env`
 * is that per-invocation env, and `c.req.raw` is the incoming Request.
 */
export const HONO_STUB = `export class Hono {
  #handler
  all(_pattern, handler) {
    this.#handler = handler
  }
  fetch = (request, env, executionCtx) => {
    return this.#handler({ env, executionCtx, req: { raw: request } })
  }
}
`

/**
 * A `@b4run/cli/fetch` stub that records what the generated entry passes.
 * `requestStores` is invoked with the same Request the handler received —
 * the contract pinned by the identity test in the hono suite.
 */
export const CLI_FETCH_STUB = `export async function createRuntimeFetchHandler(options) {
  return {
    close: async () => {},
    fetch: async (request) => {
      const stores = await options.requestStores(request)
      await stores.dispose?.()
      return new Response("ok")
    },
  }
}
export function seedModelImporter() {}
/** Every seeding call, in order — the observable for a once-per-isolate seam. */
export const seededEnvs = []
export function seedRuntimeEnv(env) {
  seededEnvs.push(env)
}
/**
 * Stands in for the real seam, whose own precedence (process.env first, seeded
 * map second) is @b4run/core's tested contract. What the emitted stores.mjs
 * has to get right — and what this records — is that it CONSULTS the seam at
 * all when a binding is absent, and uses what comes back.
 */
export function readRuntimeEnv(name) {
  return { DATABASE_URL: "postgres://from-runtime-env/db", B4_PG_WS_PROXY: "proxy:8080" }[name]
}
/** The reporting helpers the emitted stores.mjs imports; pass-through here. */
export const describeConnectionTarget = (url) => url
export const formatErrorChain = (error) => String(error?.message ?? error)
`

/** A `@b4run/cli/fetch` stub whose runtime env knows nothing. */
export const EMPTY_RUNTIME_ENV_STUB = `export function readRuntimeEnv() {
  return undefined
}
/** The reporting helpers the emitted stores.mjs imports; pass-through here. */
export const describeConnectionTarget = (url) => url
export const formatErrorChain = (error) => String(error?.message ?? error)
`

/**
 * A `@b4run/cli/fetch` stub that supplies DATABASE_URL but NOT the wsproxy
 * knob — so a request's proxy setting can only have come from its own env.
 */
export const NO_PROXY_RUNTIME_ENV_STUB = `export function readRuntimeEnv(name) {
  return { DATABASE_URL: "postgres://from-runtime-env/db" }[name]
}
/** The reporting helpers the emitted stores.mjs imports; pass-through here. */
export const describeConnectionTarget = (url) => url
export const formatErrorChain = (error) => String(error?.message ?? error)
`

export async function writeStubPackage(
  appRoot: string,
  name: string,
  source: string,
  exportsMap?: Record<string, string>,
): Promise<void> {
  const dir = join(appRoot, "node_modules", ...name.split("/"))
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify({
      exports: exportsMap ?? { ".": "./index.mjs" },
      name,
      type: "module",
      version: "0.0.0",
    })}\n`,
  )
  await writeFile(join(dir, "index.mjs"), source)
}

/** The working-tree driver-selection module, as a URL the child process can import. */
const POSTGRES_DRIVER_SOURCE_URL = pathToFileURL(
  join(cliPackageRoot, "src", "lib", "runtime", "postgres-driver.ts"),
).href

/**
 * Write the `@b4run/cli` stub, whose `./fetch` entry is `source` PLUS the real
 * driver-selection module.
 *
 * `selectPostgresDriver` is pure logic the emitted stores.mjs imports from
 * `@b4run/cli/fetch`, and it is the thing several of these tests are about —
 * so it is not stubbed. It is re-exported straight from the working-tree
 * `.ts` source: the child is Node 24, which strips types natively, so no
 * `dist` (a stale build cannot mask a change) and no transpiler is involved.
 */
export async function writeCliFetchStub(appRoot: string, source: string): Promise<void> {
  await writeStubPackage(
    appRoot,
    "@b4run/cli",
    `${source}\nexport * from ${JSON.stringify(POSTGRES_DRIVER_SOURCE_URL)}\n`,
    { "./fetch": "./index.mjs" },
  )
}

/**
 * Write `@b4run/postgres-storage` with both entries the emitted stores.mjs can
 * import: the main store factories and the `./node` pool builder.
 */
export async function writePostgresStorageStub(
  appRoot: string,
  mainSource: string = POSTGRES_STORAGE_STUB,
): Promise<void> {
  await writeStubPackage(appRoot, "@b4run/postgres-storage", mainSource, {
    ".": "./index.mjs",
    "./node": "./node.mjs",
  })
  await writeFile(
    join(appRoot, "node_modules", "@b4run", "postgres-storage", "node.mjs"),
    POSTGRES_STORAGE_NODE_STUB,
  )
}

export interface DriveEmittedStoresOptions {
  readonly cliStub?: string
  /** Expression printed after the last request. */
  readonly report?: string
  readonly reportImports?: string
  readonly storageStub?: string
  /** Keep going (and record the message) when a request throws. */
  readonly tolerateRequestFailures?: boolean
}

/**
 * Execute the emitted `stores.mjs` at `storesDir` in a plain Node child
 * process, one `createRequestStores(env)` per supplied env, and return what
 * the report expression printed — by default the neon pool connections.
 *
 * A child, not an in-process import, because vitest's resolver would alias
 * `@b4run/*` to TypeScript sources the emitted file never sees, and because the
 * emitted file's module-scope `migrated` flag belongs to the program under test.
 */
export async function driveEmittedStores(
  appRoot: string,
  storesDir: string,
  envs: readonly unknown[],
  options: DriveEmittedStoresOptions = {},
): Promise<unknown> {
  await writePostgresStorageStub(appRoot, options.storageStub ?? POSTGRES_STORAGE_STUB)
  await writeStubPackage(appRoot, "@neondatabase/serverless", NEON_STUB)
  await writeCliFetchStub(appRoot, options.cliStub ?? CLI_FETCH_STUB)

  const driverPath = join(storesDir, "drive-stores.test.mjs")
  await writeFile(
    driverPath,
    `import { poolConnections } from "@neondatabase/serverless"
${options.reportImports ?? ""}

import { createRequestStores } from "./stores.mjs"

const requestErrors = []
for (const env of ${JSON.stringify(envs)}) {
  try {
    const stores = await createRequestStores(env)
    await stores.dispose()
  } catch (error) {
    if (!${options.tolerateRequestFailures ? "true" : "false"}) throw error
    requestErrors.push(String(error?.message ?? error))
  }
}
console.log(JSON.stringify(${options.report ?? "poolConnections()"}))
`,
  )
  const { stdout } = await promisify(execFile)(process.execPath, [driverPath], { cwd: appRoot })
  return JSON.parse(stdout.trim()) as unknown
}
