import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DeliveryAdapter } from "../src/lib/delivery/adapter.ts"
import { DeliveryError } from "../src/lib/delivery/adapter.ts"
import { blobId } from "../src/lib/delivery/git-objects.ts"
import {
  createOutboxStore,
  type DeliveryIntent,
  deliveryOperationKey,
  type OutboxStore,
} from "../src/lib/delivery/outbox.ts"
import {
  DEFAULT_DELIVERY_LIMITS,
  type DeliveryContext,
  type DeliveryLimits,
  runDelivery,
} from "../src/lib/delivery/worker.ts"
import { nextState } from "../src/lib/domain/states.ts"
import type { WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { openRegistry, type Registry } from "../src/lib/registry/db.ts"
import { createWorkOrderStore, type WorkOrderStore } from "../src/lib/registry/work-orders.ts"
import { type ArtifactStore, createArtifactStore } from "../src/lib/storage/artifacts.ts"
import { createFakeGitHub, type FakeGitHub, REPOSITORY } from "./fake-delivery-adapter.ts"

/**
 * One draft-PR work order parked in `delivering` with its outbox intent committed, over a real
 * registry, and the delivery worker run against it as approve or a reconcile would run it. The
 * remote is the in-memory repository, reached through the in-memory adapter by default, or
 * through any adapter a test passes (the real one, over the fake GitHub server).
 */

export const ID = "wo-0123456789abcdef"
export const BRANCH = `factory/${ID}`
export const SOURCE = "packages/devkit/src/testing/process.ts"
export const BASELINE = "export const deadline = 'leaks'\n"
export const REPAIRED = "export const deadline = 'cleared'\n"
export const TOKEN = "ghs_faketokenfaketokenfaketoken0001"

let dir: string | undefined
let registry: Registry | undefined
/** Close the registry and remove the directory of the last harness; call in afterEach. */
export function closeHarness(): void {
  registry?.close()
  registry = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
}

export interface Harness {
  readonly github: FakeGitHub
  readonly store: WorkOrderStore
  readonly outbox: OutboxStore
  readonly waits: number[]
  readonly pin: string
  /** Run the worker once, as approve or a reconcile would, with a fresh signal. */
  deliver(options?: {
    readonly limits?: Partial<DeliveryLimits>
    readonly onEvent?: (type: string, abort: () => void) => void
    /** Before each GitHub call: a test aborts the run, or throws, in the middle of a request. */
    readonly onCall?: (method: string, abort: () => void) => void
  }): Promise<WorkOrderRow>
  events(): string[]
  journal(): string
}

export async function harness(
  options: {
    readonly stateAtCreate?: "open" | "closed"
    readonly pinFiles?: Record<string, string>
    /** The repository to seed; a fresh in-memory one by default. */
    readonly github?: FakeGitHub
    /** How the worker reaches it; the in-memory repository itself by default. */
    readonly adapter?: DeliveryAdapter
    /**
     * A real repository instead (the scratch lane): nothing is seeded, and the work order is
     * `id` at `pin` on `repository`, whose pin must hold SOURCE as BASELINE.
     */
    readonly remote?: { readonly repository: string; readonly pin: string; readonly id: string }
    /** The approved spec the pull request quotes. */
    readonly specText?: string
    /** The one changed path (repository and workspace path, as the root is "."). */
    readonly source?: string
  } = {},
): Promise<Harness> {
  const id = options.remote?.id ?? ID
  const repository = options.remote?.repository ?? REPOSITORY
  const branch = `factory/${id}`
  dir = mkdtempSync(join(tmpdir(), "delivery-worker-"))
  registry = openRegistry(join(dir, "registry.sqlite"))
  const store = createWorkOrderStore(registry.db)
  const outbox = createOutboxStore(registry.db)
  const artifacts: ArtifactStore = createArtifactStore(join(dir, "artifacts"))
  const github = options.github ?? createFakeGitHub()
  const pin =
    options.remote?.pin ??
    github.seed(
      options.pinFiles ?? {
        "README.md": "# b4\n",
        [options.source ?? SOURCE]: BASELINE,
        "packages/devkit/src/testing.ts": "export * from './testing/process.js'\n",
        ".github/workflows/ci.yml": "name: CI\n",
      },
    ).pin
  const source = options.source ?? SOURCE
  const artifact = await artifacts.put(JSON.stringify({ [source]: REPAIRED }, null, 2))
  const at = "2026-10-01T12:00:00.000Z"
  store.insert({
    id: id,
    revision: 0,
    state: "delivering",
    taskId: id,
    workerRoute: "/build#agent",
    workerThreadId: null,
    interruptId: null,
    candidateDigest: "c".repeat(64),
    bundleDigest: "b".repeat(64),
    blockedReason: null,
    failureReason: null,
    candidateAttempts: 1,
    maxCandidateAttempts: 2,
    maxActiveMs: 1_200_000,
    activeMs: 0,
    activeStartedAt: null,
    awaitingSince: at,
    origin: { kind: "issue", repository: repository, number: 912, bodyDigest: "0".repeat(64) },
    pin,
    delivery: {
      kind: "draft-pr",
      repository: repository,
      baseBranch: "main",
      branch,
      pathPrefix: ".",
      issueStateAtCreate: options.stateAtCreate ?? "open",
    },
    targetId: "devkit",
    taskDigest: "d".repeat(64),
    intakeAttempts: 1,
    maxIntakeAttempts: 2,
    createdAt: at,
    updatedAt: at,
  })
  store.recordApproval({
    id: "ap-1",
    workOrderId: id,
    bundleDigest: "b".repeat(64),
    candidateDigest: "c".repeat(64),
    decision: "approved",
    decidedBy: "operator",
    decidedAt: at,
    expiresAt: at,
  })
  const intent: DeliveryIntent = {
    version: 1,
    workOrderId: id,
    bundleDigest: "b".repeat(64),
    candidateDigest: "c".repeat(64),
    candidateArtifact: artifact.digest,
    repository: repository,
    baseBranch: "main",
    branch,
    pin,
    pathPrefix: ".",
    issue: { number: 912, stateAtCreate: options.stateAtCreate ?? "open" },
    paths: [
      {
        path: source,
        workspacePath: source,
        baselineBlob: blobId(BASELINE),
        candidateBlob: blobId(REPAIRED),
      },
    ],
    title: "factory: spawnProcess leaks its deadline timer",
    specText:
      options.specText ?? "# spawnProcess leaks its deadline timer\n\nA1: the timer is cleared.\n",
    approvedAt: at,
    decidedBy: "operator",
    digests: {
      task: "d".repeat(64),
      policy: "e".repeat(64),
      environment: `docker:sha256:${"1".repeat(64)}`,
      oracleReceiptId: "rc-oracle",
      receiptId: "rc-verify",
      reverificationReceiptId: "rc-reverify",
    },
  }
  outbox.insert({
    operationKey: deliveryOperationKey(id, "b".repeat(64)),
    approvalId: "ap-1",
    intent,
    now: at,
  })
  const waits: number[] = []
  const iso = () => new Date().toISOString()
  const deliver: Harness["deliver"] = async (run = {}) => {
    const abort = new AbortController()
    const recordEvent = (id: string, type: string, payload: Record<string, unknown> = {}) => {
      store.appendEvent(id, type, payload, iso())
      run.onEvent?.(type, () => abort.abort())
    }
    github.onCall =
      run.onCall === undefined ? undefined : (method) => run.onCall?.(method, () => abort.abort())
    const ctx: DeliveryContext = {
      store,
      outbox,
      artifacts,
      signal: abort.signal,
      iso,
      mustGet: (id) => store.get(id) as WorkOrderRow,
      recordEvent,
      transition: (id, event, patch = {}, payload = {}) =>
        store.transaction(() => {
          const row = store.get(id) as WorkOrderRow
          const to = nextState(row.state, event)
          const updated = store.update(id, row.revision, { ...patch, state: to }, iso())
          recordEvent(id, "transition", { event, from: row.state, to, ...payload })
          return updated
        }),
    }
    let clock = 0
    await runDelivery(
      ctx,
      {
        adapter: options.adapter ?? github,
        limits: { ...DEFAULT_DELIVERY_LIMITS, ...run.limits },
        sleep: async (ms) => {
          waits.push(ms)
          clock += ms
        },
        clock: () => clock,
      },
      id,
    )
    return store.get(id) as WorkOrderRow
  }
  return {
    github,
    store,
    outbox,
    waits,
    pin,
    deliver,
    events: () => store.events(id).map((e) => e.type),
    journal: () => JSON.stringify(store.events(id)),
  }
}

export const transient = (status = 502) =>
  new DeliveryError("transient", `HTTP ${status}`, undefined, status)
