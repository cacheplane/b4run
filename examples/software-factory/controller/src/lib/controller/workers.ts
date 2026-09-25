import type { DrafterEndpoint, FactoryConfig, WorkerEndpoint } from "../config.js"
import type { WorkerClient } from "../worker/client.js"
import type { WorkspaceReader } from "../worker/workspace-reader.js"

/**
 * The worker map: one builder worker for every target and pin, and one drafter, each a process
 * of its own with its own Agent Protocol endpoint and its own route: the controller reaches
 * each by URL and token alone. A work order's thread lives on exactly one of them, and which
 * one is a fact about the row (which phase parked the thread) that `ControllerContext.workerFor`,
 * `drafter` and `workerOfThread` decide. Nothing here knows a row; this is only the table.
 */

/** A builder worker as the controller talks to it. */
export interface TargetWorker {
  readonly client: WorkerClient
  readonly route: string
  /** Reads a builder thread's candidate bytes (addressed by thread AND task). */
  readonly reader: WorkspaceReader
}

/** The drafter as the controller talks to it. */
export interface DrafterWorker {
  readonly client: WorkerClient
  readonly route: string
  /** Reads a drafter thread re-rooted at `draft/` (addressed by thread alone). */
  readonly reader: WorkspaceReader
}

export interface WorkerMap {
  /** The worker for `targetId`: the one builder, which serves every target at every pin. */
  forTarget(targetId: string): TargetWorker
  readonly drafter?: DrafterWorker
}

export const DRAFTER_UNCONFIGURED = "intake is not configured: set FACTORY_DRAFTER_URL"

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
 * distinct URL, one reader for the builder (whose provider is the same for every thread),
 * and the drafter's client and reader on first use. Nothing is opened at boot — a worker
 * that is down must not decide whether the controller starts.
 */
export function createWorkerMap(
  config: Pick<FactoryConfig, "builder" | "drafter">,
  deps: WorkerMapDependencies,
): WorkerMap {
  const client = memoized(deps.createClient)
  /** One reader for the one builder: the provider it needs is the same for every thread. */
  const reader = memoized((entry: WorkerEndpoint) => deps.createBuilderReader(entry))
  const drafterEntry = config.drafter
  const drafter =
    drafterEntry === undefined
      ? undefined
      : memoized(
          (entry: DrafterEndpoint): DrafterWorker => ({
            client: client(entry.url),
            route: entry.route,
            reader: deps.createDrafterReader(entry),
          }),
        )
  /** Every target's work orders go to the one builder, at any pin. */
  const forTarget = (_targetId: string): TargetWorker => ({
    client: client(config.builder.url),
    route: config.builder.route,
    reader: reader(config.builder),
  })
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
