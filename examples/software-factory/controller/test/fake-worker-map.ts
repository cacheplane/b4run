import type { DrafterWorker, TargetWorker, WorkerMap } from "../src/lib/controller/workers.ts"
import type { WorkerClient } from "../src/lib/worker/client.ts"
import type { WorkspaceReader } from "../src/lib/worker/workspace-reader.ts"

export interface FakeWorkerMapOptions {
  /** The one builder every target resolves to. Absent: no target has a worker. */
  readonly builder?: {
    readonly client: WorkerClient
    readonly reader: WorkspaceReader
    readonly route?: string
    readonly appRoot?: string
  }
  /** The drafter. Absent: intake is not configured. */
  readonly drafter?: {
    readonly client: WorkerClient
    readonly reader: WorkspaceReader
    readonly manifestDir: string
    readonly route?: string
  }
}

/**
 * A worker map over one or two fake workers: the builder matches every target (the shape
 * the legacy single-worker pair gives), and the drafter is a second process — or the same
 * fake, for a test that only needs both roles served.
 */
export function fakeWorkerMap(options: FakeWorkerMapOptions): WorkerMap {
  const builder: TargetWorker | undefined = options.builder
    ? {
        client: options.builder.client,
        reader: options.builder.reader,
        route: options.builder.route ?? "/build#agent",
        appRoot: options.builder.appRoot ?? "/unused/builder",
      }
    : undefined
  const drafter: DrafterWorker | undefined = options.drafter
    ? {
        client: options.drafter.client,
        reader: options.drafter.reader,
        route: options.drafter.route ?? "/intake#agent",
        manifestDir: options.drafter.manifestDir,
      }
    : undefined
  return {
    forTarget: () => builder,
    ...(drafter !== undefined ? { drafter } : {}),
  }
}
