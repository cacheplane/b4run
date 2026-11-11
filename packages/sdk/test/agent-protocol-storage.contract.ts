import type {
  AspEvent,
  AspLifecycleData,
  ReceiptV1,
  RecoveryV1,
  ReducedRuntimeStore,
  Run,
  RuntimeCheckpointRecord,
  RuntimeJournalRecord,
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

// Public interrupt IDs are namespace-local and may recur in later pauses.
const pendingIdentity = {
  ownerRunId: "run",
  pausedGeneration: "pause",
  namespace: ["child"],
  inputId: "same-public-id",
  proposalHash: "proposal",
}
tx.pending.get(pendingIdentity)
// @ts-expect-error bare public interrupt IDs cannot identify durable pending records.
tx.pending.get("same-public-id")
// @ts-expect-error an address without owner/pause/proposal is ambiguous.
tx.pending.get({ namespace: ["child"], inputId: "same-public-id" })
// @ts-expect-error the current proposal identity is mandatory.
tx.pending.get({ ownerRunId: "run", pausedGeneration: "pause", namespace: [], inputId: "id" })

// Durable append owns new event coordinates; historical reads retain their existing shape.
type _AppendReturn = Expect<
  Equal<ReturnType<RuntimeTransaction["journal"]["append"]>, Promise<RuntimeJournalRecord>>
>
type _ReadReturn = Expect<
  Equal<ReturnType<RuntimeTransaction["journal"]["read"]>, Promise<readonly RuntimeJournalRecord[]>>
>
type _ReadEventPreserved = Expect<Equal<RuntimeJournalRecord["event"], AspEvent>>
type _HistoricalEmbeddedIdOptional = Expect<Equal<AspEvent["eventId"], string | undefined>>
type _HistoricalEmbeddedSeqOptional = Expect<Equal<AspEvent["seq"], number | undefined>>
type AppendArgument = Parameters<RuntimeTransaction["journal"]["append"]>[0]
type DraftLifecycle = Extract<AppendArgument["event"], { readonly method: "lifecycle" }>
type _LifecycleDiscrimination = Expect<Equal<DraftLifecycle["params"]["data"], AspLifecycleData>>

const journalDraft = {
  ownerRunId: null,
  namespace: [],
  event: {
    type: "event",
    method: "values",
    extensionOwnedByService: { retain: true }, // AspEvent's open extension index is preserved.
    params: { namespace: [], timestamp: 0, data: { ready: true } },
  },
} as const
tx.journal.append(journalDraft) // Baseline semantic RED: old append requires caller eventId.
const lifecycleDraft = {
  ownerRunId: null,
  namespace: ["child"],
  event: {
    type: "event",
    method: "lifecycle",
    params: {
      namespace: ["child"],
      timestamp: 0,
      data: { event: "running", cause: { type: "toolCall", toolCallId: "call" } },
    },
  },
} as const
tx.journal.append(lifecycleDraft)
function retainDiscriminator(event: AppendArgument["event"]): void {
  if (event.method === "lifecycle") {
    const lifecycle: AspLifecycleData = event.params.data
    void lifecycle
  }
}
void retainDiscriminator
const invalidLifecycle = {
  ...lifecycleDraft,
  event: {
    ...lifecycleDraft.event,
    params: { ...lifecycleDraft.event.params, data: { event: 42 } },
  },
} as const
// @ts-expect-error valid unsequenced input still preserves the closed lifecycle branch.
tx.journal.append(invalidLifecycle)

// Wider VARIABLES, not only excess-property checks on fresh literals.
const outerEventIdValue = { ...journalDraft, eventId: "caller-generated" }
// @ts-expect-error outer eventId is backend-owned, including an explicitly undefined key.
tx.journal.append(outerEventIdValue)
const outerEventIdUndefined = { ...journalDraft, eventId: undefined }
// @ts-expect-error outer eventId is backend-owned, including an explicitly undefined key.
tx.journal.append(outerEventIdUndefined)
const outerSeqValue = { ...journalDraft, seq: 4 }
// @ts-expect-error outer seq is backend-owned, including an explicitly undefined key.
tx.journal.append(outerSeqValue)
const outerSeqUndefined = { ...journalDraft, seq: undefined }
// @ts-expect-error outer seq is backend-owned, including an explicitly undefined key.
tx.journal.append(outerSeqUndefined)
const outerB4Value = { ...journalDraft, b4: { v: 1, delivery: "snapshot" } }
// @ts-expect-error outer b4 is backend-owned, including an explicitly undefined key.
tx.journal.append(outerB4Value)
const outerB4Undefined = { ...journalDraft, b4: undefined }
// @ts-expect-error outer b4 is backend-owned, including an explicitly undefined key.
tx.journal.append(outerB4Undefined)
const embeddedEventIdValue = {
  ...journalDraft,
  event: { ...journalDraft.event, eventId: "caller-generated" },
}
// @ts-expect-error embedded eventId is backend-owned, including an explicitly undefined key.
tx.journal.append(embeddedEventIdValue)
const embeddedEventIdUndefined = {
  ...journalDraft,
  event: { ...journalDraft.event, eventId: undefined },
}
// @ts-expect-error embedded eventId is backend-owned, including an explicitly undefined key.
tx.journal.append(embeddedEventIdUndefined)
const embeddedSeqValue = { ...journalDraft, event: { ...journalDraft.event, seq: 4 } }
// @ts-expect-error embedded seq is backend-owned, including an explicitly undefined key.
tx.journal.append(embeddedSeqValue)
const embeddedSeqUndefined = { ...journalDraft, event: { ...journalDraft.event, seq: undefined } }
// @ts-expect-error embedded seq is backend-owned, including an explicitly undefined key.
tx.journal.append(embeddedSeqUndefined)
const embeddedB4Value = {
  ...journalDraft,
  event: { ...journalDraft.event, b4: { v: 1, delivery: "snapshot" } },
}
// @ts-expect-error embedded b4 is backend-owned, including an explicitly undefined key.
tx.journal.append(embeddedB4Value)
const embeddedB4Undefined = { ...journalDraft, event: { ...journalDraft.event, b4: undefined } }
// @ts-expect-error embedded b4 is backend-owned, including an explicitly undefined key.
tx.journal.append(embeddedB4Undefined)

// Read/output compatibility intentionally retains legacy embedded-coordinate omission and IDs.
const historicalReadRecord: RuntimeJournalRecord = {
  eventId: "retained-legacy-id",
  seq: 1,
  namespace: [],
  ownerRunId: null,
  event: { type: "event", method: "values", params: { namespace: [], timestamp: 0, data: null } },
}
const readEvent: AspEvent = historicalReadRecord.event
void readEvent
// @ts-expect-error a read record's assigned outer coordinates are never a fresh append draft.
tx.journal.append(historicalReadRecord)
