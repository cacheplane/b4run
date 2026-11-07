import type { Namespace, PendingInput, ReceiptV1, RecoveryV1, RunMetadataV1 } from "./metadata.js"
import type { AspEvent, Run, RunWaitResponse, Thread, ThreadState } from "./types.js"

/** Persistence contracts, not wire schemas or backend certification. Runtime
 * state is one transaction domain; Store, managed memory and external effects
 * are separate. Implementations must validate their profile at boot. */
export type RuntimeStoreProfile = RuntimeStore | ReducedRuntimeStore

/** Deliberately cannot advertise coordinated recovery or mutation controls. */
export interface ReducedRuntimeStore {
  readonly profile: "reduced"
  readonly checkpoints: Pick<RuntimeRecords<RuntimeCheckpointRecord>, "get" | "put">
}

/** Host/backend-selected identity, never derived from public config/metadata.
 * An implementation binds this scope only after the shared authority gate and
 * durable ownership checks. These values alone are NOT authority tokens. */
export interface RuntimeStorageScope {
  readonly threadId: string
  readonly generation: string
  readonly fence: number
}

/** All keys and rows are confined to the factory-bound generation. Cross-scope
 * IDs must reject, including IDs inside payloads/ancestry. Reads return detached
 * records; modifying a returned object never modifies stored state. */
export interface RuntimeRecords<Row> {
  get(id: string): Promise<Row | undefined>
  put(record: Row): Promise<void>
  list(): Promise<readonly Row[]>
}

export interface RuntimeThreadRecord {
  readonly thread: Thread
  readonly generation: string
  readonly revision: number
  readonly headCheckpointId: string | null
  readonly currentRunId: string | null
  readonly pausedGeneration: string | null
  /** Protected host lineage/access stamp, opaque to storage. Never client metadata. */
  readonly protectedMetadata: Readonly<Record<string, unknown>>
}

export interface RuntimeRunRecord {
  readonly run: Run
  readonly metadata: RunMetadataV1
  readonly namespace: Namespace
  readonly preRunCheckpointId: string | null
  readonly result: RunWaitResponse | null
  /** Private execution identity; never projected as caller metadata. */
  readonly execution?: { readonly ownerId: string; readonly fence: number }
}

export interface RuntimeCheckpointRecord {
  readonly state: ThreadState
  readonly namespace: Namespace
  /** Canonical owner; null for non-executing state revisions. */
  readonly ownerRunId: string | null
  readonly parentCheckpointId: string | null
  /** Adapter serialization, never a pool, checkpointer or live sandbox handle. */
  readonly payload: unknown
  readonly masked: boolean
  readonly lineage: readonly RuntimeCheckpointLineage[]
}

export interface RuntimeCheckpointLineage {
  readonly threadId: string
  readonly generation: string
  readonly checkpointId: string
  readonly runId: string | null
  readonly namespace: Namespace
  readonly protectedMetadata: Readonly<Record<string, unknown>>
}

export interface RuntimePendingRecord {
  readonly input: PendingInput
  readonly ownerRunId: string
  readonly namespace: Namespace
  readonly disposition: "pending" | "answered" | "retired"
  readonly decision: unknown
  /** Server-derived protected proposal. Never projected or read from caller
   * metadata. Permission acceptance requires this for actionable rows. */
  readonly proposal?: {
    readonly agentId: string
    readonly value: unknown
    readonly rule: { readonly tool: string; readonly pattern: string }
  }
}

/** Only hashes are persisted here; grants are not public scope credentials. */
export interface RuntimeGrantRecord {
  readonly grantId: string
  readonly tokenHash: string
  readonly proposalHash: string
  readonly inputId: string
  readonly ownerRunId: string
  readonly pausedGeneration: string
  readonly namespace: Namespace
  readonly expiresAt: string | null
  readonly consumedByRunId: string | null
}

export interface RuntimeReceiptRecord {
  /** Private ledger key resolved from the validated operation scope, not a token alone. */
  readonly receiptId: string
  readonly fingerprint: string
  readonly receipt: ReceiptV1
  readonly state: "accepted" | "spent" | "retired"
  /** Private reconciliation context; never included in a public receipt/Run.
   * Legacy contextless fixture records cannot be replayed by admission. */
  readonly operation?: RuntimeOperationContext
}
export interface RuntimeOperationContext {
  readonly scopeKey: string
  readonly method: string
  readonly operationThreadId: string
  readonly targetRunId: string
  /** Original pure protocol normalization/default facts, not executable route
   * schema/reducer callbacks. Missing facts cannot authorize a fresh retry. */
  readonly normalization: {
    readonly messages: boolean
    readonly mechanicalDefaults: Readonly<Record<string, unknown>>
    readonly configDefaults: Readonly<Record<string, unknown>>
  }
  /** Original execution input/config after adapter schema/reducer processing.
   * Receipt identity is the pure protocol fingerprint, not a rehash of this. */
  readonly resolved: Readonly<Record<string, unknown>>
  readonly provenance: Readonly<Record<string, unknown>>
}
/** Trusted boot wiring only. Public requests never receive this registration
 * callback or its storage hooks. A registration is not a policy decision. */
export type RuntimeStorageFactory = (
  register: RuntimeStorageRegistration,
) => RuntimeStorageInstallation | Promise<RuntimeStorageInstallation>
export interface RuntimeStorageInstallation {
  readonly installationId: string
}
export type RuntimeStorageRegistration = (
  options: RuntimeStorageRegistrationOptions,
) => RuntimeStorageInstallation
export interface RuntimeOperationSearch {
  readonly scopeKey: string
  readonly submissionId: string
  readonly submissionKind: "b4" | "agui"
  readonly operationThreadId?: string
  readonly targetRunId?: string
  readonly method?: string
}
/** Discovery is private to the host. Authorize the actual stored subject
 * before opening its fenced store or disclosing any receipt diagnostics. */
export interface RuntimeOperationCandidate {
  readonly scope: RuntimeStorageScope
  readonly thread: RuntimeThreadRecord | undefined
  readonly receiptId: string
  readonly agentId?: string
  readonly provenance?: Readonly<Record<string, unknown>>
}
export interface RuntimeStorageRegistrationOptions {
  readonly installationId: string
  close(): void | Promise<void>
  readThread(threadId: string): Promise<RuntimeThreadRecord | undefined>
  searchOperations(query: RuntimeOperationSearch): Promise<readonly RuntimeOperationCandidate[]>
  listThreads(): Promise<readonly RuntimeThreadRecord[]>
  /** Called by the trusted host only AFTER its common authorization gate.
   * Resolve/create the canonical generation under the backend's Thread lock. */
  openThread(threadId: string, create: boolean): Promise<RuntimeStore | undefined>
  /** Optional trusted boot capability. Absence must fail execution readiness. */
  readonly execution?: RuntimeExecutionStorage
}

/** Private host/backend plumbing, not request authority or a wire API. */
export interface RuntimeExecutionStorage {
  listCandidates(): Promise<readonly string[]>
  /** Claim only an unowned or authoritatively lost Thread. Increment the fence
   * and await the started/recovery callback in the SAME transaction. A live
   * owner, including this same ownerId, returns undefined without mutation. */
  claim(
    threadId: string,
    ownerId: string,
    callback: (tx: RuntimeTransaction) => Promise<void>,
  ): Promise<RuntimeExecutionLease | undefined>
}
export interface RuntimeExecutionLease {
  readonly store: RuntimeStore
  /** Backend clock/owner proof, never a per-request clock or support flag. */
  heartbeat(): Promise<void>
  /** Revoke the bound fence before releasing durable ownership. */
  release(): Promise<void>
}

export interface RuntimeJournalRecord {
  readonly eventId: string
  readonly seq: number
  readonly namespace: Namespace
  readonly ownerRunId: string | null
  readonly event: AspEvent
}

export interface RuntimeInboxRecord {
  readonly entryId: string
  readonly kind: "dispatch" | "inject" | "control" | "rule_intent" | "webhook"
  readonly runId: string
  readonly namespace: Namespace
  readonly status: "accepted" | "applied" | "not_applied"
  readonly payload: unknown
  readonly createdAt: string
}

export interface RuntimeMaintenanceRecord {
  readonly jobId: string
  readonly kind: "rollback" | "delete_thread" | "provider_teardown" | "retention"
  readonly runId: string | null
  readonly status: "pending" | "running" | "complete"
  readonly payload: unknown
}

/** One committed cut: every field reflects the same generation, revision and
 * journal H. Pending/open sets are complete; capacity errors must not truncate.
 * Retention must preserve a leased cut and the durable tail after H. */
export interface RuntimeSnapshot {
  readonly scope: RuntimeStorageScope
  readonly revision: number
  readonly throughSeq: number
  readonly thread: RuntimeThreadRecord | undefined
  readonly recovery: RecoveryV1 | undefined
  readonly runs: readonly RuntimeRunRecord[]
  readonly checkpoints: readonly RuntimeCheckpointRecord[]
  readonly pending: readonly RuntimePendingRecord[]
  readonly grants: readonly RuntimeGrantRecord[]
  readonly receipts: readonly RuntimeReceiptRecord[]
  readonly inbox: readonly RuntimeInboxRecord[]
  readonly maintenance: readonly RuntimeMaintenanceRecord[]
}

export interface RuntimeReadLease {
  readonly leaseId: string
  readonly snapshot: RuntimeSnapshot
}

export interface RuntimeCopyPlan {
  /** Must be among the destinations pre-authorized by the internal factory.
   * Supplying a UUID does not grant access; recheck source/destination authority. */
  readonly destinationThreadId: string
  readonly destinationGeneration: string
  readonly sourceRevision: number
  readonly throughSeq: number
  /** Allocate once, persist idempotently, and include full selected ancestry. */
  readonly checkpoints: readonly {
    readonly sourceCheckpointId: string
    readonly destinationCheckpointId: string
  }[]
}

export interface RuntimeRollbackPlan {
  readonly runId: string
  readonly preRunCheckpointId: string | null
  readonly expectedRevision: number
  readonly maintenanceJobId: string
}

/** Short-lived backend transaction. Every read/write checks current generation
 * and fence authoritatively in this same transaction. No independent nested
 * connection/commit is allowed. Contexts must reject reuse after completion.
 * Service policy/preflight precedes these persistence hooks; no provider I/O or
 * human input is allowed inside the callback. */
export interface RuntimeTransaction {
  readonly scope: RuntimeStorageScope
  readonly thread: {
    get(): Promise<RuntimeThreadRecord | undefined>
    put(record: RuntimeThreadRecord): Promise<void>
  }
  readonly runs: RuntimeRecords<RuntimeRunRecord> & {
    /** Remove only Run/result; retain checkpoint/display lineage and retry tombstones. */
    delete(runId: string): Promise<void>
  }
  readonly checkpoints: RuntimeRecords<RuntimeCheckpointRecord>
  readonly pending: RuntimeRecords<RuntimePendingRecord>
  readonly grants: RuntimeRecords<RuntimeGrantRecord> & {
    /** Conditional unconsumed -> consumed transition. False never mutates a row.
     * Validate exact pause/proposal/namespace/expiry before the transition. */
    consume(
      grantId: string,
      continuationRunId: string,
      /** Only an already authenticated negative answer may abandon an expired
       * prompt. All other current owner/pause/proposal predicates still apply. */
      negativeDecision?: "deny",
    ): Promise<boolean>
  }
  readonly receipts: RuntimeRecords<RuntimeReceiptRecord>
  readonly journal: {
    /** Assign seq under the same Thread lock; materialize before commit. */
    append(record: Omit<RuntimeJournalRecord, "seq">): Promise<RuntimeJournalRecord>
    read(afterSeq: number): Promise<readonly RuntimeJournalRecord[]>
  }
  readonly inbox: RuntimeRecords<RuntimeInboxRecord>
  readonly maintenance: RuntimeRecords<RuntimeMaintenanceRecord>
  snapshot(): Promise<RuntimeSnapshot>
  /** Lock source/destination in UUID order; atomically expose a coherent copy.
   * Preserve message/activity IDs, masking and protected lineage; remap checkpoint
   * IDs. Never transfer grants, receipts, rules, aliases or live provider handles. */
  copy(plan: RuntimeCopyPlan): Promise<void>
  /** Logical generation revocation, resource cascade and durable teardown intent
   * commit together. Retain private spent-token facts; independent copies survive. */
  deleteThread(maintenanceJobId: string): Promise<void>
  /** Remove only explicitly Run-owned writes, restore the recorded head, retire
   * authority and invalidate projection/history. Reject descendant conflicts;
   * never infer ownership from timestamps or undo another transaction domain. */
  rollback(plan: RuntimeRollbackPlan): Promise<void>
}

/** Internally created, already authorized source/generation/owner binding. It is
 * not an endpoint, and a public principal, config or arbitrary store object is
 * never accepted as authority. Factories and backends must enforce this at
 * runtime; this interface alone cannot establish trust or conformance. */
export interface RuntimeStore {
  readonly profile: "coordinated"
  /** Await the entire callback, including async rejection, before COMMIT. Reject
   * on any error and roll back every enlisted mutation before resolving. */
  transaction<T>(callback: (tx: RuntimeTransaction) => Promise<T>): Promise<T>
  snapshot(): Promise<RuntimeSnapshot>
  /** Hold exclusion against copy/edit/delete/cleanup until callback settlement,
   * including provider unwind. Always release on success or rejection. */
  withReadLease<T>(callback: (lease: RuntimeReadLease) => Promise<T>): Promise<T>
}
