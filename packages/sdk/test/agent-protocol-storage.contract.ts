import type {
  ReceiptV1,
  RecoveryV1,
  ReducedRuntimeStore,
  Run,
  RuntimeCheckpointRecord,
  RuntimeReadLease,
  RuntimeReceiptRecord,
  RuntimeRunRecord,
  RuntimeSnapshot,
  RuntimeStore,
  RuntimeStoreProfile,
  RuntimeTransaction,
  ThreadState,
} from "../src/agent-protocol/index.ts"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

type _FullProfile = Expect<Equal<RuntimeStore["profile"], "coordinated">>
type _ReducedProfile = Expect<Equal<ReducedRuntimeStore["profile"], "reduced">>
type _AsyncCallback = Expect<
  Equal<Parameters<RuntimeStore["transaction"]>[0], (tx: RuntimeTransaction) => Promise<unknown>>
>
type _Fence = Expect<Equal<RuntimeTransaction["scope"]["fence"], number>>
type _Watermark = Expect<Equal<RuntimeSnapshot["throughSeq"], number>>
type _Lease = Expect<Equal<RuntimeReadLease["snapshot"], RuntimeSnapshot>>
type _CheckpointDTO = Expect<Equal<RuntimeCheckpointRecord["state"], ThreadState>>
type _RunDTO = Expect<Equal<RuntimeRunRecord["run"], Run>>
type _ReceiptDTO = Expect<Equal<RuntimeReceiptRecord["receipt"], ReceiptV1>>
type _RecoveryDTO = Expect<Equal<RuntimeSnapshot["recovery"], RecoveryV1 | undefined>>

// Importable through the portable subpath; records reuse reviewed wire DTOs.
declare const checkpoint: RuntimeCheckpointRecord
const checkpointId: string = checkpoint.state.checkpoint.checkpoint_id
void checkpointId

declare const full: RuntimeStore
declare const tx: RuntimeTransaction
const required = [
  tx.runs,
  tx.checkpoints,
  tx.pending,
  tx.grants,
  tx.receipts,
  tx.journal,
  tx.inbox,
  tx.maintenance,
  tx.copy,
  tx.deleteThread,
  tx.rollback,
  full.snapshot,
  full.withReadLease,
]
void required

// The backend factory binds validated internal authority. No request data or
// public store/principal handle can be supplied to widen a transaction's scope.
full.transaction(async (context) => {
  await context.grants.get("grant")
})
// @ts-expect-error a public principal is not a transaction callback or authority.
full.transaction({ id: "caller" })
// @ts-expect-error config cannot replace the bound generation/fence.
full.transaction({ configurable: { thread_id: "other", fence: 100 } }, async () => {})
// @ts-expect-error the transaction's generation is readonly.
tx.scope.generation = "forged"
// @ts-expect-error persisted scope never carries a caller-supplied principal.
void tx.scope.principal
// @ts-expect-error persisted scope never carries a public store handle.
void tx.scope.store
// @ts-expect-error copy takes a pre-authorized destination identity, never a store handle.
tx.copy({ destination: full, checkpointIds: [] })

const checkpointer = {
  get: async (_id: string): Promise<RuntimeCheckpointRecord | undefined> => undefined,
  put: async (_record: RuntimeCheckpointRecord): Promise<void> => {},
}
const reduced: ReducedRuntimeStore = { profile: "reduced", checkpoints: checkpointer }
// @ts-expect-error get/put alone cannot claim coordination.
const incomplete: RuntimeStore = checkpointer
void incomplete
// @ts-expect-error reduced stores do not supply transactions, fencing or recovery.
const reducedAsFull: RuntimeStore = reduced
void reducedAsFull
// @ts-expect-error a label does not supply the required hooks.
const labelOnly: RuntimeStore = { profile: "coordinated", checkpoints: checkpointer }
void labelOnly

// Each required hook is independently required, so a contract cannot silently
// degrade into an optional flags-as-support shape.
declare const noTransaction: Omit<RuntimeStore, "transaction">
// @ts-expect-error transaction required
const missingTransaction: RuntimeStore = noTransaction
declare const noSnapshot: Omit<RuntimeStore, "snapshot">
// @ts-expect-error coherent snapshot required
const missingSnapshot: RuntimeStore = noSnapshot
declare const noLease: Omit<RuntimeStore, "withReadLease">
// @ts-expect-error inspection lease required
const missingLease: RuntimeStore = noLease
declare const noCopy: Omit<RuntimeTransaction, "copy">
// @ts-expect-error copy required
const missingCopy: RuntimeTransaction = noCopy
declare const noDelete: Omit<RuntimeTransaction, "deleteThread">
// @ts-expect-error deletion required
const missingDelete: RuntimeTransaction = noDelete
declare const noFence: Omit<RuntimeTransaction, "scope">
// @ts-expect-error fenced scope required
const missingFence: RuntimeTransaction = noFence
void [missingTransaction, missingSnapshot, missingLease, missingCopy, missingDelete, missingFence]

function useProfile(store: RuntimeStoreProfile): void {
  if (store.profile === "coordinated") {
    void store.snapshot()
  } else {
    // @ts-expect-error specific coordinated controls require the full profile.
    void store.transaction(async () => {})
  }
}
void useProfile
