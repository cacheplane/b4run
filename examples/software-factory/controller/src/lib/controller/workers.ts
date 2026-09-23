import {
  type DrafterEndpoint,
  type FactoryConfig,
  type WorkerEndpoint,
  workerEndpointFor,
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
  const clients = new Map<string, WorkerClient>()
  const client = (url: string): WorkerClient => {
    let existing = clients.get(url)
    if (!existing) {
      existing = deps.createClient(url)
      clients.set(url, existing)
    }
    return existing
  }
  /** Keyed by the entry's key in `config.workers`, not the target asked for. */
  const readers = new Map<string, WorkspaceReader>()
  const reader = (key: string, entry: WorkerEndpoint): WorkspaceReader => {
    let existing = readers.get(key)
    if (!existing) {
      existing = deps.createBuilderReader(entry)
      readers.set(key, existing)
    }
    return existing
  }
  let drafter: DrafterWorker | undefined
  const map: WorkerMap = {
    forTarget(targetId) {
      const entry = workerEndpointFor(config.workers, targetId)
      if (entry === undefined) return undefined
      const key = config.workers[targetId] !== undefined ? targetId : "*"
      return {
        client: client(entry.url),
        route: entry.route,
        reader: reader(key, entry),
        appRoot: entry.appRoot,
      }
    },
  }
  if (config.drafter !== undefined) {
    const entry = config.drafter
    Object.defineProperty(map, "drafter", {
      enumerable: true,
      get: (): DrafterWorker => {
        drafter ??= {
          client: client(entry.url),
          route: entry.route,
          reader: deps.createDrafterReader(entry),
          manifestDir: entry.manifestDir,
        }
        return drafter
      },
    })
  }
  return map
}
