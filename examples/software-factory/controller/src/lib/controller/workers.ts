import {
  ANY_TARGET,
  type DrafterEndpoint,
  type FactoryConfig,
  type WorkerEndpoint,
} from "../config.js"
import type { WorkerClient } from "../worker/client.js"
import type { WorkspaceReader } from "../worker/workspace-reader.js"

/**
 * The worker map (spec §6.4, plan Task 4): one builder worker per target and one drafter,
 * each a process of its own with its own Agent Protocol endpoint, its own app root (where
 * its installation store lives) and its own route. A work order's thread lives on exactly
 * one of them, and which one is a fact about the row — its target, and which phase parked
 * the thread — that `ControllerContext.workerFor`, `drafter` and `workerOfThread` decide.
 * Nothing here knows a row; this is only the table.
 */

/** A builder worker as the controller talks to it. */
export interface TargetWorker {
  readonly client: WorkerClient
  readonly route: string
  /** Reads a builder thread's candidate bytes (addressed by thread AND task). */
  readonly reader: WorkspaceReader
  readonly appRoot: string
  /**
   * Where `dispatch` writes the work order's manifest before it creates the thread: the
   * builder process's `FACTORY_BUILDER_MANIFEST_DIR`.
   */
  readonly manifestDir: string
}

/** The drafter as the controller talks to it. */
export interface DrafterWorker {
  readonly client: WorkerClient
  readonly route: string
  /** Reads a drafter thread re-rooted at `draft/` (addressed by thread alone). */
  readonly reader: WorkspaceReader
  /** Where `intake` writes the work order's manifest before it creates the thread. */
  readonly manifestDir: string
}

export interface WorkerMap {
  /** The worker for `targetId`: its own entry, else the wildcard, else none. */
  forTarget(targetId: string): TargetWorker | undefined
  readonly drafter?: DrafterWorker
}

/** A target no worker entry (and no wildcard) covers: the row cannot be dispatched. */
export class NoWorkerForTargetError extends Error {
  constructor(readonly targetId: string) {
    super(`no worker for target ${targetId}`)
    this.name = "NoWorkerForTargetError"
  }
}

export const DRAFTER_UNCONFIGURED =
  "intake is not configured: set FACTORY_DRAFTER_URL and FACTORY_DRAFTER_APP_ROOT"

/** No drafter is configured: nothing can start or read an intake thread. */
export class DrafterUnconfiguredError extends Error {
  constructor() {
    super(DRAFTER_UNCONFIGURED)
    this.name = "DrafterUnconfiguredError"
  }
}

/** What building the map needs from the process: injectable so a test can count what is made. */
export interface WorkerMapDependencies {
  createClient(url: string): WorkerClient
  createBuilderReader(entry: WorkerEndpoint): WorkspaceReader
  createDrafterReader(entry: DrafterEndpoint): WorkspaceReader
}

/** A value made on first use and kept: `memo(k)` calls `make(k)` once per distinct `k`. */
function memoized<K, V>(make: (key: K) => V): (key: K) => V {
  const made = new Map<K, V>()
  return (key) => {
    let value = made.get(key)
    if (value === undefined) {
      value = make(key)
      made.set(key, value)
    }
    return value
  }
}

/**
 * The map from the configuration. Everything is built lazily and once: one client per
 * distinct URL (two targets served by one process share a connection), one reader per
 * worker entry (a wildcard entry is one entry, whose reader resolves the provider per task),
 * and the drafter's client and reader on first use. Nothing is opened at boot — a worker
 * that is down must not decide whether the controller starts.
 */
export function createWorkerMap(
  config: Pick<FactoryConfig, "workers" | "drafter">,
  deps: WorkerMapDependencies,
): WorkerMap {
  const client = memoized(deps.createClient)
  /** The entry a target resolves to, under the key it has in `config.workers`: its own, else the wildcard's. */
  const resolve = (targetId: string): { key: string; entry: WorkerEndpoint } | undefined => {
    const key = config.workers[targetId] !== undefined ? targetId : ANY_TARGET
    const entry = config.workers[key]
    return entry === undefined ? undefined : { key, entry }
  }
  /** One reader per entry, keyed by the entry's key, not the target asked for. */
  const readerFor = memoized((key: string) =>
    deps.createBuilderReader(config.workers[key] as WorkerEndpoint),
  )
  const drafterEntry = config.drafter
  const drafter =
    drafterEntry === undefined
      ? undefined
      : memoized(
          (entry: DrafterEndpoint): DrafterWorker => ({
            client: client(entry.url),
            route: entry.route,
            reader: deps.createDrafterReader(entry),
            manifestDir: entry.manifestDir,
          }),
        )
  const forTarget = (targetId: string): TargetWorker | undefined => {
    const resolved = resolve(targetId)
    if (resolved === undefined) return undefined
    const { key, entry } = resolved
    return {
      client: client(entry.url),
      route: entry.route,
      reader: readerFor(key),
      appRoot: entry.appRoot,
      manifestDir: entry.manifestDir,
    }
  }
  // A getter, not a spread over one: spreading would read it at boot.
  if (drafter !== undefined && drafterEntry !== undefined)
    return {
      forTarget,
      get drafter() {
        return drafter(drafterEntry)
      },
    }
  return { forTarget }
}
