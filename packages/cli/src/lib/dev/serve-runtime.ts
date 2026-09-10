import type { B4Config } from "@b4run/core"
// All store/middleware imports are type-only — they erase at runtime.
import type { MemoryStore } from "@b4run/memory"
import type { PermissionsStore } from "@b4run/permissions"
import type { B4Middleware } from "@b4run/sdk"
import type { ThreadsStore } from "@b4run/sqlite-storage"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import type { B4StaticModules } from "../runtime/static-modules.js"
import { startRuntimeServer } from "./runtime-server.js"

export interface ServeRuntimeOptions {
  readonly appRoot: string
  readonly host?: string
  readonly port?: number
  readonly installSignalHandlers?: boolean
  /** A build-time-generated module manifest — see `StartRuntimeServerOptions.modules`. */
  readonly modules?: B4StaticModules
  /** An already-constructed B4Config — see `StartRuntimeServerOptions.config`. */
  readonly config?: B4Config
  /** Boot-resolved checkpointer — see `StartRuntimeServerOptions.checkpointer`. */
  readonly checkpointer?: BaseCheckpointSaver
  /** Boot-resolved threads store — see `StartRuntimeServerOptions.threadsStore`. */
  readonly threadsStore?: ThreadsStore
  /**
   * Boot-resolved permissions store (instance or factory). When provided it
   * wins regardless of the "boot" permissionsMode this entry point sets —
   * see `StartRuntimeServerOptions.permissionsStore`.
   */
  readonly permissionsStore?: PermissionsStore | (() => Promise<PermissionsStore>)
  /** Lazy memory-store thunk — see `StartRuntimeServerOptions.memoryStore`. */
  readonly memoryStore?: () => Promise<MemoryStore>
  /** Pre-loaded middleware — see `StartRuntimeServerOptions.middleware`. */
  readonly middleware?: B4Middleware
}

export interface ServeRuntimeHandle {
  readonly url: string
  readonly close: () => Promise<void>
}

/** Default production listen port, matching the emitted Dockerfile healthcheck. */
const DEFAULT_SERVE_PORT = 8000

/**
 * Resolve the production listen port.
 *
 * An explicit `opts.port` always wins (including `0` for a random port). An
 * empty or non-numeric `PORT` env var is treated as "unset" and falls back to
 * {@link DEFAULT_SERVE_PORT} — this keeps `serveRuntime` in lockstep with the
 * Dockerfile healthcheck's `PORT||8000`, instead of `Number("")` silently
 * binding a random port.
 */
export function resolveServePort(
  explicitPort: number | undefined,
  envPort: string | undefined,
): number {
  if (explicitPort !== undefined) {
    return explicitPort
  }
  if (envPort === undefined) {
    return DEFAULT_SERVE_PORT
  }
  const trimmed = envPort.trim()
  if (trimmed === "") {
    return DEFAULT_SERVE_PORT
  }
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : DEFAULT_SERVE_PORT
}

/**
 * Boot the B4.run runtime HTTP server for production use (`b4 serve`).
 *
 * Hands off directly to `startRuntimeServer`, the single assembly point
 * (runtime registry + threads store + checkpointer + sandbox manager + HTTP
 * listener) that `b4 dev` also uses in its child process. Unlike `b4 dev`,
 * serveRuntime never watches the filesystem or restarts — it starts once and
 * stays up.
 *
 * Deliberately does NOT run typegen at boot. The host `b4 build` already
 * generated `.b4/*` (COPY'd into the image), and the runtime's schema
 * injection is best-effort with a fallback to discovered tools when those
 * artifacts are absent. Running typegen here would WRITE `.b4/*`, crashing a
 * read-only-rootfs production container with EROFS — see PR #339 review.
 */
export async function serveRuntime(opts: ServeRuntimeOptions): Promise<ServeRuntimeHandle> {
  const host = opts.host ?? process.env.HOST ?? "0.0.0.0"
  const port = resolveServePort(opts.port, process.env.PORT)
  const installSignalHandlers = opts.installSignalHandlers ?? false

  // Production loads the permissions store once at boot ("boot" mode); dev
  // keeps the default "per-request" re-load so mid-process HITL "Always"
  // grants written to .b4/permissions.json still apply without a restart.
  const server = await startRuntimeServer({
    appRoot: opts.appRoot,
    host,
    ...(opts.checkpointer ? { checkpointer: opts.checkpointer } : {}),
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.memoryStore ? { memoryStore: opts.memoryStore } : {}),
    ...(opts.middleware ? { middleware: opts.middleware } : {}),
    ...(opts.modules ? { modules: opts.modules } : {}),
    ...(opts.permissionsStore ? { permissionsStore: opts.permissionsStore } : {}),
    permissionsMode: "boot",
    port,
    ...(opts.threadsStore ? { threadsStore: opts.threadsStore } : {}),
  })

  if (!installSignalHandlers) {
    return server
  }

  let closed = false

  const close = async (): Promise<void> => {
    if (closed) {
      return
    }
    closed = true
    process.off("SIGTERM", onSignal)
    process.off("SIGINT", onSignal)
    await server.close()
  }

  const onSignal = (): void => {
    void close()
  }

  process.once("SIGTERM", onSignal)
  process.once("SIGINT", onSignal)

  return { close, url: server.url }
}
