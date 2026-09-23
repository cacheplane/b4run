import type { FactoryOptions } from "../src/lib/controller/factory.ts"
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
    /**
     * Where `dispatch` writes builder manifests. A path nothing creates by default: a test
     * that does not care boots with {@link noopBuilderManifestWriter}, and one that asserts on
     * the file names a directory of its own.
     */
    readonly manifestDir?: string
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
        manifestDir: options.builder.manifestDir ?? "/unused/builder-manifests",
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

/**
 * The builder manifest writer for tests whose builder is a fake: nothing reads a manifest, so
 * nothing is captured (the real writer archives the task's target at its pin) and nothing is
 * written. `dispatch` still journals `builder_manifest_written` with this path; there is no
 * file for a removal to find, so no `builder_manifest_removed` follows.
 */
export const noopBuilderManifestWriter: NonNullable<
  FactoryOptions["writeBuilderManifest"]
> = async ({ dir, workOrderId }) => ({
  path: `${dir}/${workOrderId}.json`,
  sourceDigest: "0".repeat(64),
})
