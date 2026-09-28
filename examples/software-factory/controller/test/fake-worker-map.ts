import { createSourceBundle } from "@b4run/workspace/node"
import { BuilderHandoffSchema, stagedReferenceOf } from "../src/lib/builder-handoff.ts"
import type { FactoryOptions } from "../src/lib/controller/factory.ts"
import type { DrafterWorker, TargetWorker, WorkerMap } from "../src/lib/controller/workers.ts"
import { DrafterHandoffSchema } from "../src/lib/drafter-handoff.ts"
import type { WorkerClient } from "../src/lib/worker/client.ts"
import type { WorkspaceReader } from "../src/lib/worker/workspace-reader.ts"

export interface FakeWorkerMapOptions {
  /**
   * The one builder every target resolves to. Absent: asking for it throws, as a map that
   * cannot serve a row would.
   */
  readonly builder?: {
    readonly client: WorkerClient
    readonly reader: WorkspaceReader
    readonly route?: string
  }
  /** The drafter. Absent: intake is not configured. */
  readonly drafter?: {
    readonly client: WorkerClient
    readonly reader: WorkspaceReader
    readonly route?: string
  }
}

/**
 * A worker map over one or two fake workers: the builder matches every target (the shape the
 * one builder gives), and the drafter is a second process — or the same fake, for a test that
 * only needs both roles served.
 */
export function fakeWorkerMap(options: FakeWorkerMapOptions): WorkerMap {
  const builder: TargetWorker | undefined = options.builder
    ? {
        client: options.builder.client,
        reader: options.builder.reader,
        route: options.builder.route ?? "/build#agent",
      }
    : undefined
  const drafter: DrafterWorker | undefined = options.drafter
    ? {
        client: options.drafter.client,
        reader: options.drafter.reader,
        route: options.drafter.route ?? "/intake#agent",
      }
    : undefined
  return {
    forTarget: (targetId) => {
      if (builder === undefined)
        throw new Error(`no worker for target ${targetId} in this fake map`)
      return builder
    },
    ...(drafter !== undefined ? { drafter } : {}),
  }
}

/**
 * The builder handoff capture for tests whose builder is a fake: nothing serves the workspace,
 * so the target is not archived at its pin (the real capture is) and the source is one small
 * file. `dispatch` still uploads it and creates the thread naming it, which the fake worker
 * checks as the real one does: a create naming a source it was not sent is refused.
 */
export const fakeBuilderHandoff: NonNullable<FactoryOptions["captureBuilderHandoff"]> = async ({
  taskId,
  workOrderId,
  image,
}) => {
  const workspace = {
    version: 1 as const,
    source: createSourceBundle([
      { path: "TASK.md", bytes: new TextEncoder().encode(`# ${taskId}\n`), executable: false },
    ]),
    environmentLinks: [],
    baseline: "git" as const,
  }
  const handoff = BuilderHandoffSchema.parse({
    version: 4,
    workOrderId,
    taskId,
    targetId: "fake-target",
    workspace: stagedReferenceOf(workspace),
    target: {
      // The bound image's id when dispatch bound one; the tag stays the fake target's own, since
      // the handoff's tag must name its target and pin and this handoff's are the fake's.
      image: image?.localId ?? `sha256:${"0".repeat(64)}`,
      tag: `b4-factory-fake-target:${"0".repeat(12)}-${"0".repeat(12)}`,
      pin: "0".repeat(40),
      policy: {
        network: { mode: "deny" },
        env: {},
        resources: { memoryMb: 1024, cpus: 1, timeoutMs: 60_000 },
      },
      permissions: {},
    },
  })
  return { handoff, workspace }
}

/**
 * The drafter handoff capture for tests whose drafter is a fake: the pin is no commit of any
 * repository, so the wide capture (tens of MiB) is stood in for by one small file. `intake`
 * still uploads it and creates the thread naming it.
 */
export const fakeDrafterHandoff: NonNullable<FactoryOptions["captureDrafterHandoff"]> = async ({
  workOrderId,
}) => {
  const workspace = {
    version: 1 as const,
    source: createSourceBundle([
      { path: "repo/README.md", bytes: new TextEncoder().encode("# fixture\n"), executable: false },
    ]),
    environmentLinks: [],
  }
  const handoff = DrafterHandoffSchema.parse({
    version: 2,
    workOrderId,
    workspace: stagedReferenceOf(workspace),
  })
  return { handoff, workspace }
}
