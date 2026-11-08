import type { PermissionContinuationRequest } from "@b4run/core/internal/permission-continuation"
import {
  type ApprovalGrantMinter,
  type BackendActiveInput,
  createApprovalGrant,
  hashApprovalGrant,
} from "@b4run/sdk"
import type {
  RuntimeAcceptedPermissionBinding,
  RuntimeCheckpointRecord,
  RuntimeNamespaceBinding,
  RuntimePendingRecord,
  RuntimeReceiptRecord,
  RuntimeStoppedSourceProof,
  RuntimeStore,
  RuntimeTransaction,
} from "@b4run/sdk/agent-protocol"
import {
  runtimeStoppedSourceWitness,
  stoppedSourceMatchesRun,
} from "@b4run/sdk/internal/runtime-identity"
import type { RunnableConfig } from "@langchain/core/runnables"
import { getConfig } from "@langchain/langgraph"
import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
  WRITES_IDX_MAP,
} from "@langchain/langgraph-checkpoint"
import { ProtocolError } from "../dev/protocol/errors.js"
import { injectionPayload } from "./inputs.js"
import { canonical, hash } from "./operation-ledger.js"

type Encoded = readonly [string, readonly number[]]
interface NativePayload {
  readonly kind: "langgraph"
  readonly v: 1
  readonly checkpoint: Encoded | null
  readonly metadata: Encoded | null
  readonly safeHead?: true
  readonly binding?: Pick<
    RuntimeNamespaceBinding,
    "agentId" | "namespaceGeneration" | "parentCheckpointId" | "status" | "source"
  >
  readonly writes: readonly {
    readonly kind: "execution" | "administrative"
    readonly taskId: string
    readonly index: number
    readonly channel: string
    readonly value: Encoded
    readonly ownerRunId: string
    readonly fence: number
    readonly namespaceGeneration: string
    readonly sourceCheckpointId: string | null
  }[]
}
export interface RuntimeCheckpointSaverOptions {
  readonly store: RuntimeStore
  readonly runId: string
  readonly namespace: readonly string[]
  readonly binding?: Pick<
    RuntimeNamespaceBinding,
    "agentId" | "namespaceGeneration" | "parentCheckpointId" | "status" | "source"
  >
  /** Only trusted runtime boundary code installs this commit hook. */
  readonly commitInputs?: (tx: RuntimeTransaction, ids: unknown) => Promise<void>
  readonly activeInput?: BackendActiveInput
  readonly failpoint?: (point: "afterCheckpoint" | "afterWrites") => void | Promise<void>
}
const savers = new WeakMap<BaseCheckpointSaver, RuntimeCheckpointSaver>()
type NativeBinding = NonNullable<NonNullable<RuntimePendingRecord["proposal"]>["nativeBinding"]>
interface ContinuationProof {
  readonly tasks: ReadonlyMap<string, ReadonlySet<string>>
  readonly resumes: ReadonlyMap<string, ReadonlyMap<string, unknown>>
  readonly lineage: ReadonlyMap<string, ReadonlySet<string>>
  readonly markers: ReadonlyMap<
    string,
    {
      readonly checkpointId: string
      readonly ids: readonly string[]
      readonly owners: ReadonlySet<string>
    }
  >
  assert(tx: RuntimeTransaction): Promise<void>
}
export async function verifyRuntimeNativePermission(
  saver: BaseCheckpointSaver | undefined,
  tx: RuntimeTransaction,
  runId: string,
  proposal: {
    readonly namespace: readonly string[]
    readonly interruptId: string
    readonly request: Readonly<Record<string, unknown>>
    readonly protectedProposal: unknown
    readonly agentId?: string
    readonly nativeBinding?: NativeBinding
  },
): Promise<void> {
  const owned = saver ? savers.get(saver) : undefined
  if (!owned || owned.owner().runId !== runId || !proposal.nativeBinding)
    throw new ProtocolError("not_supported")
  await owned.verifyPermission(
    tx,
    proposal.nativeBinding,
    proposal.namespace,
    proposal.interruptId,
    proposal.request,
    proposal.protectedProposal,
    proposal.agentId,
  )
}

/** Existing canonical permission service is the sole caller. This private
 * saver proof never travels in graph input/config or persisted grant state. */
export async function bindRuntimePermissionContinuation(options: {
  readonly store: RuntimeStore
  readonly checkpointer: BaseCheckpointSaver
  readonly runId: string
  readonly proposalHash: (pending: RuntimePendingRecord) => string
}) {
  const owned = savers.get(options.checkpointer)
  if (!owned || !owned.belongsTo(options.store) || owned.owner().runId !== options.runId)
    throw new ProtocolError("not_supported")
  return owned.bindContinuation(options.proposalHash)
}
/** Administrative proof only, inside the already authorized rebind TX. */
export async function bindRuntimeStoppedContinuation(options: {
  readonly store: RuntimeStore
  readonly checkpointer: BaseCheckpointSaver
  readonly runId: string
  readonly tx: RuntimeTransaction
  readonly proposalHash: (pending: RuntimePendingRecord) => string
}) {
  const owned = savers.get(options.checkpointer)
  if (
    !owned ||
    owned.enlisted !== options.tx ||
    !owned.belongsTo(options.store) ||
    owned.owner().runId !== options.runId
  )
    throw new ProtocolError("not_supported")
  const proof = await owned.bindContinuation(options.proposalHash, true)
  if (!proof.stoppedSource) throw new ProtocolError("not_supported")
  return proof.stoppedSource
}
export function createRuntimeNativeParkMinter(
  store: RuntimeStore,
  saver: BaseCheckpointSaver,
  runId: string,
  enabled: boolean,
) {
  const owned = savers.get(saver)
  if (!owned || !owned.belongsTo(store) || owned.owner().runId !== runId)
    throw new ProtocolError("not_supported")
  return owned.createParkMinter(enabled)
}
export function runtimePermissionResolver(saver: BaseCheckpointSaver) {
  const owned = savers.get(saver)
  if (!owned) throw new ProtocolError("not_supported")
  return (request: PermissionContinuationRequest) => owned.resolvePermission(request)
}
export async function runtimeNativePermissionBinding(
  saver: BaseCheckpointSaver,
  checkpointId: string,
  taskId: string,
  interruptId: string,
): Promise<NativeBinding> {
  const owned = savers.get(saver)
  if (!owned) throw new ProtocolError("not_supported")
  return owned.nativeBinding(checkpointId, taskId, interruptId)
}
export function runtimeNativeParkGrant(
  saver: BaseCheckpointSaver | undefined,
  binding: NativeBinding,
  publicId: string,
) {
  const owned = saver ? savers.get(saver) : undefined
  if (!owned) throw new ProtocolError("not_supported")
  return owned.parkGrant(binding, publicId)
}
/** Rebind has already proved actual unwind and holds the native transaction.
 * Every public graph state API operation enlists into that SAME transaction. */
export async function withRuntimeCheckpointTransaction<T>(
  saver: BaseCheckpointSaver,
  store: RuntimeStore,
  tx: RuntimeTransaction,
  callback: () => Promise<T>,
): Promise<T> {
  const owned = savers.get(saver)
  if (!owned || owned.enlisted || !owned.belongsTo(store)) throw new ProtocolError("not_supported")
  const restore = owned.enlist(tx)
  try {
    return await callback()
  } finally {
    restore()
  }
}
/** Installed only after the same authorized TX verified explicit source proof. */
export async function enlistRuntimeAdministrativeSource(
  saver: BaseCheckpointSaver,
  store: RuntimeStore,
  tx: RuntimeTransaction,
) {
  const owned = savers.get(saver),
    thread = await tx.thread.get()
  if (!owned || owned.enlisted !== tx || !owned.belongsTo(store) || !thread?.headCheckpointId)
    throw new ProtocolError("not_supported")
  owned.administrativeSource = thread.headCheckpointId
}
export function createRuntimeCheckpointSaver(
  options: RuntimeCheckpointSaverOptions,
): BaseCheckpointSaver {
  if (options.namespace.length && !options.binding) throw new ProtocolError("not_supported")
  const saver = new RuntimeCheckpointSaver(options)
  savers.set(saver, saver)
  return saver
}
/** Private CLI plumbing, never exported from a public package entrypoint. */
export function runtimeCheckpointOwner(saver: BaseCheckpointSaver | undefined) {
  return saver ? savers.get(saver)?.owner() : undefined
}
export async function runtimeChildCheckpointBinding(
  saver: BaseCheckpointSaver,
  agentId: string,
  config: RunnableConfig,
) {
  const owned = savers.get(saver)
  if (!owned) throw new ProtocolError("not_supported")
  return owned.childBinding(agentId, config)
}
/** Execution selection only; native history APIs retain their explicit IDs. */
export async function runtimeChildExecutionConfig(
  saver: BaseCheckpointSaver,
  config: RunnableConfig,
): Promise<RunnableConfig> {
  const owned = savers.get(saver)
  if (!owned) throw new ProtocolError("not_supported")
  return owned.childExecutionConfig(config)
}
export async function inheritRuntimeChildContinuation(
  parent: BaseCheckpointSaver,
  child: BaseCheckpointSaver,
) {
  const source = savers.get(parent),
    target = savers.get(child)
  if (
    !source ||
    !target ||
    !source.belongsTo(target.owner().store) ||
    source.owner().runId !== target.owner().runId
  )
    throw new ProtocolError("not_supported")
  await target.inherit(source)
}
class RuntimeCheckpointSaver extends BaseCheckpointSaver {
  enlisted: RuntimeTransaction | undefined
  administrativeSource: string | undefined
  private readonly administrativeRevisions = new Set<string>()
  private continuation: ContinuationProof | undefined
  private readonly issued = new Map<
    string,
    {
      readonly grant: string
      readonly tokenHash: string
      readonly taskId: string
      readonly index: number
      readonly generation: string
    }
  >()
  private mintSession: object | undefined
  private readonly observations = new Map<
    string,
    {
      readonly request: PermissionContinuationRequest
      readonly generation: string
      readonly agentId: string
      readonly bytes: number
    }
  >()
  private acceptedResolver:
    | ((request: PermissionContinuationRequest) => Promise<boolean | undefined>)
    | undefined
  enlist(tx: RuntimeTransaction) {
    const continuation = this.continuation,
      resolver = this.acceptedResolver
    this.administrativeRevisions.clear()
    this.enlisted = tx
    return () => {
      this.enlisted = undefined
      this.administrativeSource = undefined
      this.administrativeRevisions.clear()
      this.continuation = continuation
      this.acceptedResolver = resolver
    }
  }
  async resolvePermission(request: PermissionContinuationRequest): Promise<boolean | undefined> {
    const accepted = await this.acceptedResolver?.(request)
    if (accepted !== undefined) return accepted
    if (
      !this.mintSession ||
      request.runId !== this.options.runId ||
      request.protectedProposal === undefined ||
      !Number.isSafeInteger(request.interruptIndex) ||
      request.interruptIndex < 0
    )
      throw new ProtocolError("not_supported")
    await this.options.store.transaction(async (tx) => {
      await this.validate(tx, this.config(tx.scope.threadId, request.checkpointId), true)
      const namespace = request.checkpointNs.split("|").slice(0, -1)
      if (request.checkpointNs.split("|").at(-1)?.split(":").at(-1) !== request.nativeTaskId)
        throw new ProtocolError("approval_changed")
      const proof = namespace.length
        ? (await tx.nativeNamespaces.list()).find(
            (row) =>
              row.runId === this.options.runId &&
              canonical(row.namespace) === canonical(namespace) &&
              row.status === "running",
          )
        : undefined
      const head = namespace.length
        ? proof?.checkpointId
        : (await tx.thread.get())?.headCheckpointId
      const parent = await tx.checkpoints.get(request.checkpointId)
      if (
        !parent ||
        head !== request.checkpointId ||
        canonical(parent.namespace) !== canonical(namespace) ||
        (parent.ownerRunId !== this.options.runId &&
          !this.continuation?.tasks.get(request.checkpointId)?.has(request.nativeTaskId))
      )
        throw new ProtocolError("approval_changed")
      const serialized = JSON.stringify(request),
        snapshot = JSON.parse(serialized) as PermissionContinuationRequest
      if (canonical(snapshot) !== canonical(request)) throw new ProtocolError("not_supported")
      const bytes = new TextEncoder().encode(serialized).byteLength,
        key = hash([request.checkpointId, request.nativeTaskId, request.interruptIndex])
      const prior = this.observations.get(key)
      if (
        (!prior && this.observations.size >= 128) ||
        [...this.observations.values()].reduce((sum, row) => sum + row.bytes, 0) -
          (prior?.bytes ?? 0) +
          bytes >
          1048576
      )
        throw new ProtocolError("capacity_exceeded")
      const agentId = proof?.agentId ?? (await tx.runs.get(this.options.runId))?.run.agent_id
      if (!agentId) throw new ProtocolError("approval_changed")
      this.observations.set(key, {
        request: snapshot,
        generation: proof?.namespaceGeneration ?? this.options.runId,
        agentId,
        bytes,
      })
    })
    return undefined
  }
  async nativeBinding(
    checkpointId: string,
    taskId: string,
    interruptId: string,
  ): Promise<NativeBinding> {
    return this.options.store.transaction(async (tx) => {
      await this.validate(tx, this.config(tx.scope.threadId, checkpointId), true)
      const row = await tx.checkpoints.get(checkpointId)
      if (!row) throw new ProtocolError("approval_changed")
      const writes = this.payload(row).writes.filter(
        (write) =>
          write.kind === "execution" &&
          write.taskId === taskId &&
          write.channel === "__interrupt__" &&
          write.ownerRunId === this.options.runId,
      )
      const matches: NativeBinding[] = []
      for (const write of writes) {
        const item = await this.nativeInterrupt(write.value)
        if (item.id !== interruptId) continue
        const { interruptId: _public, grant: _grant, ...request } = item.value
        for (const observation of this.observations.values()) {
          const actual = observation.request
          if (
            actual.checkpointId === checkpointId &&
            actual.nativeTaskId === taskId &&
            canonical(actual.request) === canonical(request)
          )
            matches.push({
              checkpointId,
              taskId,
              interruptId,
              checkpointNs: actual.checkpointNs,
              interruptIndex: actual.interruptIndex,
              namespaceGeneration: observation.generation,
            })
        }
      }
      if (matches.length !== 1) throw new ProtocolError("approval_changed")
      return matches[0]!
    })
  }
  createParkMinter(enabled: boolean): { readonly minter?: ApprovalGrantMinter; dispose(): void } {
    if (this.mintSession) throw new ProtocolError("thread_busy")
    const session = Object.freeze({})
    this.mintSession = session
    let disposed = false
    const minter: ApprovalGrantMinter = {
      mint: async ({ interruptId, checkpointNs }) => {
        if (disposed || this.mintSession !== session) throw new ProtocolError("stale_generation")
        const config = getConfig(),
          ambient = config?.configurable
        const taskId = ambient?.__pregel_task_id,
          scratchpad = ambient?.__pregel_scratchpad as { interruptCounter?: unknown } | undefined
        const parts = checkpointNs.split("|"),
          namespace = parts.slice(0, -1)
        if (
          !config ||
          ambient?.checkpoint_ns !== checkpointNs ||
          typeof taskId !== "string" ||
          parts.at(-1)?.split(":").at(-1) !== taskId ||
          typeof scratchpad?.interruptCounter !== "number" ||
          !Number.isSafeInteger(scratchpad.interruptCounter) ||
          scratchpad.interruptCounter < -1
        )
          throw new ProtocolError("approval_changed")
        const index = scratchpad.interruptCounter + 1
        return this.options.store.transaction(async (tx) => {
          await this.validate(
            tx,
            {
              configurable: {
                thread_id: ambient.thread_id,
                checkpoint_ns: this.options.namespace.join("|"),
              },
            },
            true,
          )
          const proof = namespace.length
            ? (await tx.nativeNamespaces.list()).find(
                (row) =>
                  row.runId === this.options.runId &&
                  canonical(row.namespace) === canonical(namespace) &&
                  row.status === "running",
              )
            : undefined
          if (namespace.length && !proof) throw new ProtocolError("stale_generation")
          const parentId =
            (ambient.checkpoint_map as Record<string, unknown> | undefined)?.[
              namespace.join("|")
            ] ?? ambient.checkpoint_id
          const parent =
            typeof parentId === "string" ? await tx.checkpoints.get(parentId) : undefined
          if (
            !parent ||
            canonical(parent.namespace) !== canonical(namespace) ||
            (parent.ownerRunId !== this.options.runId &&
              !this.continuation?.tasks.get(parentId as string)?.has(taskId))
          )
            throw new ProtocolError("stale_generation")
          const observation = this.observations.get(hash([parentId, taskId, index]))
          if (!observation || observation.request.checkpointNs !== checkpointNs)
            throw new ProtocolError("approval_changed")
          const key = hash([checkpointNs, interruptId]),
            existing = this.issued.get(key)
          if (existing) {
            if (existing.taskId !== taskId || existing.index !== index)
              throw new ProtocolError("approval_changed")
            return existing.grant
          }
          if (this.issued.size >= 128) throw new ProtocolError("capacity_exceeded")
          const artifact = {
            ...(await createApprovalGrant()),
            taskId,
            index,
            generation: proof?.namespaceGeneration ?? this.options.runId,
          }
          if (disposed) throw new ProtocolError("stale_generation")
          this.issued.set(key, artifact)
          return artifact.grant
        })
      },
    }
    return {
      ...(enabled ? { minter } : {}),
      dispose: () => {
        disposed = true
        if (this.mintSession === session) {
          this.issued.clear()
          this.observations.clear()
          this.mintSession = undefined
        }
      },
    }
  }
  parkGrant(binding: NativeBinding, publicId: string) {
    const artifact = this.issued.get(hash([binding.checkpointNs, publicId]))
    if (
      !artifact ||
      artifact.taskId !== binding.taskId ||
      artifact.index !== binding.interruptIndex ||
      artifact.generation !== binding.namespaceGeneration
    )
      throw new ProtocolError("grant_invalid")
    return artifact
  }
  constructor(private readonly options: RuntimeCheckpointSaverOptions) {
    super()
  }
  belongsTo(store: RuntimeStore) {
    return store === this.options.store
  }
  owner() {
    return {
      store: this.options.store,
      runId: this.options.runId,
      namespace: this.options.namespace,
    }
  }
  async childBinding(agentId: string, config: RunnableConfig) {
    const native = config.configurable?.checkpoint_ns,
      map = config.configurable?.checkpoint_map as Record<string, unknown> | undefined
    const parentId = map?.[this.options.namespace.join("|")] ?? config.configurable?.checkpoint_id
    if (typeof native !== "string" || !native.length || typeof parentId !== "string")
      throw new ProtocolError("not_supported")
    const namespace = native.split("|"),
      nativeTask = namespace.at(-1)!.split(":").at(-1)!
    if (
      canonical(namespace.slice(0, -1)) !== canonical(this.options.namespace) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(nativeTask)
    )
      throw new ProtocolError("not_supported")
    return this.options.store.transaction(async (tx) => {
      await this.validate(
        tx,
        {
          configurable: {
            thread_id: config.configurable?.thread_id,
            checkpoint_ns: this.options.namespace.join("|"),
          },
        },
        true,
      )
      const parent = await tx.checkpoints.get(parentId)
      if (!parent || canonical(parent.namespace) !== canonical(this.options.namespace))
        throw new ProtocolError("stale_generation")
      if (parent.ownerRunId === this.options.runId)
        return {
          namespace,
          binding: {
            agentId,
            namespaceGeneration: nativeTask,
            parentCheckpointId: parentId,
            status: "running" as const,
          },
        }
      if (!this.continuation?.tasks.get(parentId)?.has(nativeTask))
        throw new ProtocolError("stale_generation")
      await this.continuation.assert(tx)
      const run = await tx.runs.get(this.options.runId),
        records = await tx.nativeNamespaces.list()
      const prior = records.find(
        (record) =>
          record.runId === run?.metadata.previousRunId &&
          canonical(record.namespace) === canonical(namespace),
      )
      if (
        !prior ||
        prior.status !== "parked" ||
        prior.agentId !== agentId ||
        prior.parentCheckpointId !== parentId ||
        !this.continuation.tasks.has(prior.checkpointId)
      )
        throw new ProtocolError("approval_changed")
      const creators = (await tx.receipts.list()).filter(
        (receipt) =>
          receipt.receipt.runId === this.options.runId &&
          receipt.operation?.method === "input.respond",
      )
      if (creators.length !== 1) throw new ProtocolError("approval_changed")
      const source = {
        v: 1 as const,
        kind: "permission_continuation" as const,
        threadId: tx.scope.threadId,
        generation: tx.scope.generation,
        runId: prior.runId,
        aliasId: prior.aliasId,
        namespaceGeneration: prior.namespaceGeneration,
        checkpointId: prior.checkpointId,
        parentCheckpointId: prior.parentCheckpointId,
        receiptId: creators[0]!.receiptId,
      }
      const aliasId = `namespace:${hash([tx.scope.threadId, tx.scope.generation, this.options.runId, namespace])}`
      const existing = await tx.nativeNamespaces.get(aliasId),
        thread = await tx.thread.get()
      if (!thread) throw new ProtocolError("stale_generation")
      if (
        existing &&
        (existing.status !== "running" ||
          existing.agentId !== agentId ||
          canonical(existing.source) !== canonical(source))
      )
        throw new ProtocolError("stale_generation")
      const binding = {
        agentId,
        namespaceGeneration: existing?.namespaceGeneration ?? crypto.randomUUID(),
        parentCheckpointId: parentId,
        status: "running" as const,
        source,
      }
      if (!existing) {
        await tx.nativeNamespaces.put({
          v: 1,
          kind: "native_namespace",
          aliasId,
          runId: this.options.runId,
          namespace,
          ...binding,
          checkpointId: prior.checkpointId,
          revision: thread.revision + 1,
        })
        await tx.thread.put({ ...thread, revision: thread.revision + 1 })
      }
      return { namespace, binding }
    })
  }
  async childExecutionConfig(config: RunnableConfig): Promise<RunnableConfig> {
    if (!this.options.namespace.length || !this.options.binding)
      throw new ProtocolError("not_supported")
    return this.options.store.transaction(async (tx) => {
      await this.validate(tx, config, true)
      const run = await tx.runs.get(this.options.runId),
        thread = await tx.thread.get(),
        binding = this.options.binding!
      if (
        !run ||
        !thread ||
        (await tx.inbox.list()).some(
          (row) =>
            row.kind === "control" && row.runId === this.options.runId && row.status === "accepted",
        )
      )
        throw new ProtocolError("stale_generation")
      const native = config.configurable!,
        supplied = native.checkpoint_map
      if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
        throw new ProtocolError("not_supported")
      const namespaces = await tx.nativeNamespaces.list()
      const find = (namespace: readonly string[]) =>
        namespaces.find(
          (row) =>
            row.runId === this.options.runId && canonical(row.namespace) === canonical(namespace),
        )
      const current = find(this.options.namespace)
      if (
        current &&
        (current.status !== "running" ||
          current.agentId !== binding.agentId ||
          current.namespaceGeneration !== binding.namespaceGeneration ||
          current.parentCheckpointId !== binding.parentCheckpointId ||
          canonical(current.source) !== canonical(binding.source))
      )
        throw new ProtocolError("stale_generation")
      if (!current && binding.source) throw new ProtocolError("stale_generation")
      const selected = current?.checkpointId
      if (selected) {
        const checkpoint = await tx.checkpoints.get(selected)
        if (
          !checkpoint ||
          canonical(checkpoint.namespace) !== canonical(this.options.namespace) ||
          (checkpoint.ownerRunId !== this.options.runId &&
            (selected !== binding.source?.checkpointId || !this.continuation?.tasks.has(selected)))
        )
          throw new ProtocolError("stale_generation")
        if (checkpoint.ownerRunId !== this.options.runId) await this.continuation!.assert(tx)
      }
      const map: Record<string, string> = {}
      let namespace = this.options.namespace.slice(0, -1),
        parentId = binding.parentCheckpointId
      for (;;) {
        const key = namespace.join("|"),
          parent = await tx.checkpoints.get(parentId),
          parentBinding = namespace.length ? find(namespace) : undefined
        if (
          !parent ||
          canonical(parent.namespace) !== canonical(namespace) ||
          supplied[key] !== parentId ||
          (namespace.length
            ? !parentBinding ||
              parentBinding.status !== "running" ||
              parentBinding.checkpointId !== parentId
            : thread.headCheckpointId !== parentId)
        )
          throw new ProtocolError("stale_generation")
        if (parent.ownerRunId !== this.options.runId) {
          if (
            !this.continuation ||
            (namespace.length
              ? parentBinding?.source?.checkpointId !== parentId
              : run.preRunCheckpointId !== parentId || !run.metadata.previousRunId)
          )
            throw new ProtocolError("stale_generation")
          await this.continuation.assert(tx)
        }
        map[key] = parentId
        if (!namespace.length) break
        parentId = parentBinding!.parentCheckpointId
        namespace = namespace.slice(0, -1)
      }
      // Pinned Pregel treats an explicit own-namespace map/ID as replay and
      // drops RESUME writes. The same owner-bound saver selects its validated
      // canonical alias head implicitly; only verified ancestor maps remain.
      const { checkpoint_id: _id, checkpoint_map: _map, ...rest } = native
      return { ...config, configurable: { ...rest, checkpoint_map: map }, durability: "sync" }
    })
  }
  async inherit(parent: RuntimeCheckpointSaver) {
    if (!this.options.binding?.source) return
    const proof = parent.continuation
    if (!proof) throw new ProtocolError("not_supported")
    const selected = await this.options.store.transaction(async (tx) => {
      await proof.assert(tx)
      const tasks = new Map<string, ReadonlySet<string>>(),
        resumes = new Map<string, ReadonlyMap<string, unknown>>(),
        lineage = new Map<string, ReadonlySet<string>>()
      for (const [id, nativeTasks] of proof.tasks) {
        const row = await tx.checkpoints.get(id)
        if (row && this.options.namespace.every((part, index) => row.namespace[index] === part)) {
          tasks.set(id, nativeTasks)
          resumes.set(id, proof.resumes.get(id)!)
          lineage.set(id, proof.lineage.get(id)!)
        }
      }
      if (!tasks.has(this.options.binding!.source!.checkpointId))
        throw new ProtocolError("approval_changed")
      const markers = new Map(
        [...proof.markers].filter(([namespace]) => {
          const parts = JSON.parse(namespace) as string[]
          return this.options.namespace.every((part, index) => parts[index] === part)
        }),
      )
      return { tasks, resumes, lineage, markers, assert: proof.assert } satisfies ContinuationProof
    })
    this.continuation = selected
  }
  private async transaction<T>(callback: (tx: RuntimeTransaction) => Promise<T>): Promise<T> {
    return this.enlisted ? callback(this.enlisted) : this.options.store.transaction(callback)
  }
  private namespaceId(tx: RuntimeTransaction): string {
    return `namespace:${hash([tx.scope.threadId, tx.scope.generation, this.options.runId, this.options.namespace])}`
  }
  private async validate(
    tx: RuntimeTransaction,
    config: RunnableConfig,
    write = false,
  ): Promise<void> {
    const namespace = config.configurable?.checkpoint_ns ?? ""
    if (
      config.configurable?.thread_id !== tx.scope.threadId ||
      namespace !== this.options.namespace.join("|")
    )
      throw new ProtocolError("not_found", { resource: "namespace" })
    const run = await tx.runs.get(this.options.runId),
      thread = await tx.thread.get()
    if (!run || !thread || run.metadata.generation !== tx.scope.generation)
      throw new ProtocolError("stale_generation")
    if (this.options.binding) {
      const parent = await tx.checkpoints.get(this.options.binding.parentCheckpointId)
      if (
        !parent ||
        (this.options.binding.source
          ? !this.continuation
          : parent.ownerRunId !== this.options.runId ||
            this.options.namespace.at(-1)?.split(":").at(-1) !==
              this.options.binding.namespaceGeneration)
      )
        throw new ProtocolError("stale_generation")
    }
    if (write && this.enlisted) {
      if (
        thread.currentRunId !== this.options.runId ||
        run.metadata.phase !== "settled" ||
        run.metadata.continuation !== "closed" ||
        (await tx.executionOwner()) !== null ||
        (!run.unwoundAt && !run.ownershipLoss)
      )
        throw new ProtocolError("thread_busy")
      return
    }
    if (write && this.options.namespace.length) {
      const binding = await tx.nativeNamespaces.get(this.namespaceId(tx))
      if (
        binding &&
        (binding.status !== "running" ||
          binding.agentId !== this.options.binding?.agentId ||
          binding.namespaceGeneration !== this.options.binding?.namespaceGeneration ||
          binding.parentCheckpointId !== this.options.binding?.parentCheckpointId ||
          canonical(binding.source) !== canonical(this.options.binding?.source))
      )
        throw new ProtocolError("stale_generation")
    }
    if (
      write &&
      (thread.currentRunId !== this.options.runId ||
        run.execution?.fence !== tx.scope.fence ||
        run.execution.ownerId !== (await tx.executionOwner()) ||
        (!this.enlisted && run.metadata.phase !== "running"))
    )
      throw new ProtocolError("stale_generation")
  }
  private payload(row: RuntimeCheckpointRecord): NativePayload {
    const value = row.payload as NativePayload
    if (
      value?.v !== 1 ||
      value.kind !== "langgraph" ||
      !Array.isArray(value.writes) ||
      value.writes.some((write) => !write || !["execution", "administrative"].includes(write.kind))
    )
      throw new ProtocolError("storage_unavailable")
    return value
  }
  private config(threadId: string, id: string): RunnableConfig {
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: this.options.namespace.join("|"),
        checkpoint_id: id,
      },
    }
  }
  private async encode(value: unknown): Promise<Encoded> {
    const [kind, bytes] = await this.serde.dumpsTyped(value)
    return [kind, Array.from(bytes)]
  }
  private decode(encoded: Encoded): Promise<unknown> {
    return this.serde.loadsTyped(encoded[0], Uint8Array.from(encoded[1]))
  }
  private async nativeInterrupt(
    encoded: Encoded,
  ): Promise<{ readonly id: string; readonly value: Record<string, unknown> }> {
    const item = (await this.decode(encoded)) as { id?: unknown; value?: unknown } | null
    // Pinned PregelRunner commits ONE Interrupt per __interrupt__ write,
    // whereas graph.getState projects those writes as a task interrupt list.
    if (
      !item ||
      typeof item.id !== "string" ||
      !item.id.length ||
      !item.value ||
      typeof item.value !== "object" ||
      Array.isArray(item.value)
    )
      throw new ProtocolError("approval_changed")
    return { id: item.id, value: item.value as Record<string, unknown> }
  }
  private async tuple(
    tx: RuntimeTransaction,
    row: RuntimeCheckpointRecord,
  ): Promise<CheckpointTuple | undefined> {
    const payload = this.payload(row)
    if (!payload.checkpoint) return undefined
    const checkpoint = (await this.decode(payload.checkpoint)) as Checkpoint
    if (checkpoint.id !== row.state.checkpoint.checkpoint_id)
      throw new ProtocolError("storage_unavailable")
    const allowed = this.continuation?.lineage.get(checkpoint.id)
    if (allowed) await this.continuation!.assert(tx)
    // Keep every owner-tagged entry durably, but project each native key once.
    // The verified chain is collected newest -> oldest; native resume arrays
    // already contain the earlier answer prefix and must never be concatenated.
    const owners = [
      ...new Set([row.ownerRunId, ...[...(allowed ?? [])].reverse(), this.options.runId]),
    ]
    const selected = new Map<string, NativePayload["writes"][number]>()
    for (const owner of owners)
      for (const write of payload.writes) {
        if (
          write.ownerRunId === owner &&
          (write.kind === "execution" ||
            (this.enlisted &&
              (this.administrativeSource === checkpoint.id ||
                this.administrativeRevisions.has(checkpoint.id)) &&
              write.ownerRunId === this.options.runId &&
              write.fence === tx.scope.fence))
        )
          selected.set(hash([write.taskId, write.index]), write)
      }
    const writes = [...selected.values()]
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      writes.map(
        async (write) =>
          [write.taskId, write.channel, await this.decode(write.value)] as CheckpointPendingWrite,
      ),
    )
    return {
      config: this.config(tx.scope.threadId, checkpoint.id),
      checkpoint,
      ...(payload.metadata
        ? { metadata: (await this.decode(payload.metadata)) as CheckpointMetadata }
        : {}),
      ...(row.parentCheckpointId
        ? { parentConfig: this.config(tx.scope.threadId, row.parentCheckpointId) }
        : {}),
      pendingWrites,
    }
  }
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return this.transaction(async (tx) => {
      await this.validate(tx, config)
      const id = config.configurable?.checkpoint_id
      const head =
        id ??
        (this.options.namespace.length
          ? (await tx.nativeNamespaces.get(this.namespaceId(tx)))?.checkpointId
          : (await tx.thread.get())?.headCheckpointId)
      const row = typeof head === "string" ? await tx.checkpoints.get(head) : undefined
      if (row && canonical(row.namespace) !== canonical(this.options.namespace))
        throw new ProtocolError("storage_unavailable")
      return row ? this.tuple(tx, row) : undefined
    })
  }
  async *list(
    config: RunnableConfig,
    options: CheckpointListOptions = {},
  ): AsyncGenerator<CheckpointTuple> {
    const tuples = await this.transaction(async (tx) => {
      await this.validate(tx, config)
      const before = options.before?.configurable?.checkpoint_id
      const rows = (await tx.checkpoints.list())
        .filter(
          (row) =>
            canonical(row.namespace) === canonical(this.options.namespace) &&
            (!before || row.state.checkpoint.checkpoint_id < before),
        )
        .reverse()
      const result: CheckpointTuple[] = []
      for (const row of rows) {
        const tuple = await this.tuple(tx, row)
        if (
          tuple &&
          (!options.filter ||
            Object.entries(options.filter).every(
              ([key, value]) =>
                canonical((tuple.metadata as Record<string, unknown> | undefined)?.[key]) ===
                canonical(value),
            ))
        )
          result.push(tuple)
        if (options.limit !== undefined && result.length >= options.limit) break
      }
      return result
    })
    yield* tuples
  }
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _versions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const encoded = await this.encode(checkpoint),
      encodedMetadata = await this.encode(metadata)
    return this.transaction(async (tx) => {
      await this.validate(tx, config, true)
      const existing = await tx.checkpoints.get(checkpoint.id)
      if (
        existing &&
        (existing.ownerRunId !== this.options.runId ||
          canonical(existing.namespace) !== canonical(this.options.namespace))
      )
        throw new ProtocolError("stale_generation")
      const parentId = config.configurable?.checkpoint_id as string | undefined
      if (parentId === checkpoint.id) throw new ProtocolError("storage_unavailable")
      const payload: NativePayload = {
        kind: "langgraph",
        v: 1,
        checkpoint: encoded,
        metadata: encodedMetadata,
        writes: existing ? this.payload(existing).writes : [],
        ...(this.options.binding ? { binding: this.options.binding } : {}),
      }
      await tx.checkpoints.put({
        state: { checkpoint: { checkpoint_id: checkpoint.id }, values: {} },
        namespace: this.options.namespace,
        ownerRunId: this.enlisted ? null : this.options.runId,
        parentCheckpointId: parentId ?? null,
        payload,
        masked: false,
        lineage: [],
      })
      if (this.enlisted) this.administrativeRevisions.add(checkpoint.id)
      await this.options.failpoint?.("afterCheckpoint")
      const ids = checkpoint.channel_values._b4AppliedInputIds
      if (!this.enlisted) {
        const inherited = this.continuation?.markers.get(canonical(this.options.namespace))
        if (inherited?.ids.length && canonical(ids) === canonical(inherited.ids))
          await this.continuation!.assert(tx)
        else if (this.options.commitInputs) await this.options.commitInputs(tx, ids)
        else if (Array.isArray(ids) && ids.length) throw new ProtocolError("storage_unavailable")
      }
      const thread = await tx.thread.get()
      if (!thread) throw new ProtocolError("stale_generation")
      if (this.options.binding) {
        await tx.nativeNamespaces.put({
          v: 1,
          kind: "native_namespace",
          aliasId: this.namespaceId(tx),
          runId: this.options.runId,
          namespace: this.options.namespace,
          ...this.options.binding,
          checkpointId: checkpoint.id,
          revision: thread.revision + 1,
        })
      }
      await tx.thread.put({
        ...thread,
        ...(this.options.namespace.length ? {} : { headCheckpointId: checkpoint.id }),
        revision: thread.revision + 1,
      })
      return this.config(tx.scope.threadId, checkpoint.id)
    })
  }
  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const values = await Promise.all(
      writes.map(async ([channel, value], index) => ({
        taskId,
        channel,
        index: WRITES_IDX_MAP[channel] ?? index,
        value: await this.encode(value),
      })),
    )
    await this.transaction(async (tx) => {
      await this.validate(tx, config, true)
      const id = config.configurable?.checkpoint_id as string | undefined
      if (!id || !taskId) throw new ProtocolError("storage_unavailable")
      const existing = await tx.checkpoints.get(id)
      const run = await tx.runs.get(this.options.runId)
      const safeSource =
        existing?.ownerRunId === null &&
        this.payload(existing).safeHead &&
        run?.preRunCheckpointId === id
      const administrativeSource =
        !!this.enlisted && this.administrativeSource === id && existing?.namespace.length === 0
      const resumed = id ? this.continuation?.resumes.get(id) : undefined
      const resumeSource =
        resumed?.has(taskId) &&
        writes.every(
          ([channel, value]) =>
            channel === "__resume__" &&
            Array.isArray(value) &&
            canonical(value.at(-1)) === canonical(resumed.get(taskId)),
        )
      const continuationSource =
        !!id && (this.continuation?.tasks.get(id)?.has(taskId) || resumeSource)
      if (continuationSource) await this.continuation!.assert(tx)
      if (
        existing &&
        ((!safeSource &&
          !continuationSource &&
          !administrativeSource &&
          existing.ownerRunId !== this.options.runId) ||
          canonical(existing.namespace) !== canonical(this.options.namespace))
      )
        throw new ProtocolError("stale_generation")
      const previous = existing
        ? this.payload(existing)
        : {
            kind: "langgraph" as const,
            v: 1 as const,
            checkpoint: null,
            metadata: null,
            writes: [],
          }
      const indexed = new Map(
        previous.writes.map((write) => [
          hash([write.kind, write.ownerRunId, write.taskId, write.index]),
          write,
        ]),
      )
      const kind = this.enlisted ? ("administrative" as const) : ("execution" as const)
      for (const write of values) {
        const key = hash([kind, this.options.runId, write.taskId, write.index])
        if (write.index < 0 || !indexed.has(key))
          indexed.set(key, {
            ...write,
            kind,
            ownerRunId: this.options.runId,
            fence: tx.scope.fence,
            namespaceGeneration: this.options.binding?.namespaceGeneration ?? this.options.runId,
            sourceCheckpointId:
              continuationSource || safeSource || administrativeSource ? id! : null,
          })
      }
      await tx.checkpoints.put({
        ...(existing ?? {
          state: { checkpoint: { checkpoint_id: id }, values: {} },
          namespace: this.options.namespace,
          ownerRunId: this.options.runId,
          parentCheckpointId: null,
          masked: false,
          lineage: [],
        }),
        payload: { ...previous, writes: [...indexed.values()] },
      })
      await this.options.failpoint?.("afterWrites")
    })
  }
  async verifyPermission(
    tx: RuntimeTransaction,
    binding: NativeBinding,
    namespace: readonly string[],
    publicId: string,
    request: Readonly<Record<string, unknown>>,
    protectedProposal: unknown,
    agentId?: string,
  ): Promise<void> {
    if (this.options.namespace.length && canonical(namespace) !== canonical(this.options.namespace))
      throw new ProtocolError("approval_changed")
    await this.validate(tx, this.config(tx.scope.threadId, binding.checkpointId), true)
    const namespaceProof = namespace.length
      ? (await tx.nativeNamespaces.list()).find(
          (row) =>
            row.runId === this.options.runId && canonical(row.namespace) === canonical(namespace),
        )
      : undefined
    if (
      (namespace.length && !namespaceProof) ||
      binding.namespaceGeneration !== (namespaceProof?.namespaceGeneration ?? this.options.runId) ||
      !Number.isSafeInteger(binding.interruptIndex) ||
      binding.interruptIndex < 0
    )
      throw new ProtocolError("approval_changed")
    const observation = this.observations.get(
      hash([binding.checkpointId, binding.taskId, binding.interruptIndex]),
    )
    const selectedAgent = agentId ?? (await tx.runs.get(this.options.runId))?.run.agent_id
    if (
      !observation ||
      observation.agentId !== selectedAgent ||
      observation.request.checkpointNs !== binding.checkpointNs ||
      observation.generation !== binding.namespaceGeneration ||
      canonical(observation.request.request) !== canonical(request) ||
      canonical(observation.request.protectedProposal) !== canonical(protectedProposal)
    )
      throw new ProtocolError("approval_changed")
    const parts = binding.checkpointNs.split("|")
    if (
      canonical(parts.slice(0, -1)) !== canonical(namespace) ||
      parts.at(-1)?.split(":").at(-1) !== binding.taskId
    )
      throw new ProtocolError("approval_changed")
    const row = await tx.checkpoints.get(binding.checkpointId)
    if (
      !row ||
      canonical(row.namespace) !== canonical(namespace) ||
      (row.ownerRunId !== this.options.runId &&
        !this.continuation?.tasks.get(binding.checkpointId)?.has(binding.taskId))
    )
      throw new ProtocolError("approval_changed")
    const writes = this.payload(row).writes.filter(
      (write) =>
        write.kind === "execution" &&
        write.taskId === binding.taskId &&
        write.channel === "__interrupt__",
    )
    let matched = false
    for (const write of writes) {
      for (const item of [await this.nativeInterrupt(write.value)]) {
        if (item?.id !== binding.interruptId) continue
        const { interruptId, grant, ...nativeRequest } = item.value ?? {}
        const artifact = this.issued.get(hash([binding.checkpointNs, publicId]))
        if (
          interruptId === publicId &&
          canonical(nativeRequest) === canonical(request) &&
          (grant === undefined ||
            (artifact?.grant === grant && artifact.index === binding.interruptIndex))
        )
          matched = true
      }
    }
    if (!matched) throw new ProtocolError("approval_changed")
  }

  async bindContinuation(
    proposalHash: (pending: RuntimePendingRecord) => string,
    administrative = false,
  ) {
    const prepared = await this.transaction(async (tx) => {
      await this.validate(
        tx,
        {
          configurable: {
            thread_id: tx.scope.threadId,
            checkpoint_ns: this.options.namespace.join("|"),
          },
        },
        true,
      )
      const run = await tx.runs.get(this.options.runId),
        thread = await tx.thread.get()
      if (!run?.metadata.previousRunId || !thread?.headCheckpointId)
        throw new ProtocolError("not_supported")
      const receipts = await tx.receipts.list(),
        allPending = await tx.pending.list()
      const previousRunId = run.metadata.previousRunId,
        owner = run.execution?.ownerId
      const witness = administrative ? runtimeStoppedSourceWitness(run) : undefined
      if (administrative && !witness) throw new ProtocolError("not_supported")
      const stoppedWitness: RuntimeStoppedSourceProof | undefined = witness
        ? {
            v: 1,
            ...witness,
            creatorMethod: "input.respond",
            path: [
              {
                runId: this.options.runId,
                previousRunId,
                receiptId: "",
                selectedHead: thread.headCheckpointId,
                protectedSource: null,
              },
            ],
          }
        : undefined
      const cuts: {
        receipt: RuntimeReceiptRecord
        pending: RuntimePendingRecord[]
        bindings: Map<string, RuntimeAcceptedPermissionBinding>
      }[] = []
      const chain = [this.options.runId]
      let segment = this.options.runId
      for (;;) {
        const creators = receipts.filter(
          (row) =>
            row.receipt.runId === segment &&
            ["run.create", "input.respond"].includes(row.operation?.method ?? ""),
        )
        if (creators.length !== 1) throw new ProtocolError("approval_changed")
        const receipt = creators[0]!,
          operation = receipt.operation!
        if (
          receipt.state !== "accepted" ||
          operation.operationThreadId !== tx.scope.threadId ||
          receipt.receipt.turnId !== run.metadata.turnId
        )
          throw new ProtocolError("approval_changed")
        if (operation.method === "run.create") {
          if (segment === this.options.runId || operation.targetRunId !== segment)
            throw new ProtocolError("approval_changed")
          break
        }
        const source = operation.targetRunId
        if (
          !source ||
          chain.includes(source) ||
          (segment === this.options.runId && source !== previousRunId)
        )
          throw new ProtocolError("approval_changed")
        const pending = allPending.filter(
          (row) => row.ownerRunId === source && row.disposition === "answered",
        )
        const acceptedBindings = operation.permissionBindings
        if (
          !pending.length ||
          pending.some((row) => !row.proposal?.nativeBinding) ||
          !Array.isArray(acceptedBindings) ||
          acceptedBindings.length !== pending.length
        )
          throw new ProtocolError("not_supported")
        const bindings = new Map(
          acceptedBindings.map((binding) => [
            canonical([binding.namespace, binding.inputId]),
            binding,
          ]),
        )
        if (bindings.size !== pending.length) throw new ProtocolError("approval_changed")
        for (const item of pending) {
          const binding = bindings.get(canonical([item.namespace, item.input.data.interruptId]))
          if (
            !binding ||
            binding.v !== 1 ||
            !["off", "optional", "required"].includes(binding.grantMode) ||
            binding.ownerRunId !== source ||
            binding.pausedGeneration !== item.input.data.b4.pausedGeneration ||
            binding.proposalHash !== item.input.data.b4.proposalHash ||
            canonical(binding.nativeBinding) !== canonical(item.proposal!.nativeBinding) ||
            binding.decision !== item.decision
          )
            throw new ProtocolError("approval_changed")
        }
        cuts.push({ receipt, pending, bindings })
        chain.push(source)
        segment = source
      }
      const pending = cuts[0]!.pending
      const markers = new Map<
        string,
        {
          readonly checkpointId: string
          readonly ids: readonly string[]
          readonly owners: ReadonlySet<string>
        }
      >()
      const verifyAccepted = async (current: RuntimeTransaction) => {
        const active = await current.runs.get(this.options.runId),
          t = await current.thread.get()
        const ownerValid = administrative
          ? !!active &&
            !!stoppedWitness &&
            stoppedSourceMatchesRun(stoppedWitness, active, current.scope.fence) &&
            t?.pausedGeneration === null &&
            (await current.executionOwner()) === null &&
            !(await current.pending.list()).some(
              (row) => row.ownerRunId === this.options.runId && row.disposition === "pending",
            )
          : active?.metadata.phase === "running" &&
            active.execution?.fence === current.scope.fence &&
            active.execution.ownerId === owner &&
            owner === (await current.executionOwner())
        if (
          !active ||
          t?.currentRunId !== this.options.runId ||
          !ownerValid ||
          active.metadata.previousRunId !== previousRunId ||
          (await current.inbox.list()).some(
            (row) =>
              row.kind === "control" &&
              row.runId === this.options.runId &&
              row.status === "accepted",
          )
        )
          throw new ProtocolError("stale_generation")
        const records = await current.grants.list(),
          currentPending = await current.pending.list()
        for (const cut of cuts) {
          if (
            canonical(await current.receipts.get(cut.receipt.receiptId)) !==
              canonical(cut.receipt) ||
            canonical(
              currentPending.filter(
                (row) =>
                  row.ownerRunId === cut.receipt.operation!.targetRunId &&
                  row.disposition === "answered",
              ),
            ) !== canonical(cut.pending)
          )
            throw new ProtocolError("approval_changed")
          for (const item of cut.pending) {
            if (
              !item.proposal ||
              proposalHash(item) !== item.input.data.b4.proposalHash ||
              !["once", "always", "deny"].includes(String(item.decision))
            )
              throw new ProtocolError("approval_changed")
            const matching = records.filter(
              (grant) =>
                grant.ownerRunId === item.ownerRunId &&
                grant.inputId === item.input.data.interruptId &&
                grant.pausedGeneration === item.input.data.b4.pausedGeneration &&
                grant.proposalHash === item.input.data.b4.proposalHash &&
                canonical(grant.namespace) === canonical(item.namespace),
            )
            const accepted = cut.bindings.get(
              canonical([item.namespace, item.input.data.interruptId]),
            )!
            if (accepted.grantMode === "off") {
              if (accepted.grantId !== null) throw new ProtocolError("grant_invalid")
            } else if (
              (accepted.grantMode === "required" && matching.length !== 1) ||
              matching.some((grant) => grant.consumedByRunId !== cut.receipt.receipt.runId) ||
              (accepted.grantId === null
                ? matching.length !== 0
                : matching.length !== 1 || matching[0]?.grantId !== accepted.grantId)
            )
              throw new ProtocolError("grant_invalid")
            const binding = item.proposal.nativeBinding!,
              row = await current.checkpoints.get(binding.checkpointId)
            if (!row || canonical(row.namespace) !== canonical(item.namespace))
              throw new ProtocolError("approval_changed")
            const actual = this.payload(row).writes.filter(
              (write) =>
                write.kind === "execution" &&
                write.ownerRunId === item.ownerRunId &&
                write.taskId === binding.taskId &&
                write.channel === "__interrupt__",
            )
            let found = false
            for (const write of actual) {
              const interrupt = await this.nativeInterrupt(write.value)
              const { interruptId, grant: token, ...request } = interrupt.value
              if (
                interrupt.id !== binding.interruptId ||
                interruptId !== item.input.data.interruptId ||
                canonical(request) !==
                  canonical((item.input.data.payload as { request: unknown }).request)
              )
                continue
              if (matching.length > 1) throw new ProtocolError("grant_invalid")
              const grant = accepted.grantId
                ? records.find((record) => record.grantId === accepted.grantId)
                : matching[0]
              if (
                grant
                  ? typeof token !== "string" ||
                    (await hashApprovalGrant(token)) !== grant.tokenHash
                  : token !== undefined
              )
                throw new ProtocolError("grant_invalid")
              found = true
            }
            if (!found) throw new ProtocolError("approval_changed")
          }
        }
        if (administrative && witness && witness.kind !== "accepted_not_started") {
          const head = t?.headCheckpointId
            ? await current.checkpoints.get(t.headCheckpointId)
            : undefined
          if (!head || head.namespace.length || head.ownerRunId === this.options.runId)
            throw new ProtocolError("approval_changed")
          const writes = this.payload(head).writes
          for (const item of cuts[0]!.pending) {
            const binding = item.proposal!.nativeBinding!
            const selected = writes.filter(
              (write) =>
                write.kind === "execution" &&
                write.ownerRunId === this.options.runId &&
                write.taskId === binding.interruptId &&
                write.channel === "__resume__",
            )
            if (selected.length !== 1) throw new ProtocolError("approval_changed")
            const write = selected[0]!,
              value = await this.decode(write.value)
            if (
              write.fence !== witness.execution.fence ||
              write.namespaceGeneration !== this.options.runId ||
              write.sourceCheckpointId !== head.state.checkpoint.checkpoint_id ||
              !Array.isArray(value) ||
              value.at(-1) !== item.decision
            )
              throw new ProtocolError("approval_changed")
          }
        }
        for (const [namespace, marker] of markers) {
          const source = await current.checkpoints.get(marker.checkpointId)
          const checkpoint = source && this.payload(source).checkpoint
          if (
            !checkpoint ||
            canonical(
              ((await this.decode(checkpoint)) as Checkpoint).channel_values._b4AppliedInputIds,
            ) !== canonical(marker.ids)
          )
            throw new ProtocolError("approval_changed")
          for (const id of marker.ids) {
            const input = await current.inbox.get(id)
            if (
              !input ||
              input.kind !== "inject" ||
              input.status !== "applied" ||
              !marker.owners.has(input.runId) ||
              canonical(input.namespace) !== namespace
            )
              throw new ProtocolError("approval_changed")
            const payload = injectionPayload(input),
              receipt = await current.receipts.get(payload.receiptId)
            const epoch = input.namespace.length
              ? (
                  await current.nativeNamespaces.get(
                    `namespace:${hash([current.scope.threadId, current.scope.generation, input.runId, input.namespace])}`,
                  )
                )?.namespaceGeneration
              : input.runId
            if (
              payload.generation !== current.scope.generation ||
              payload.namespaceGeneration !== epoch ||
              receipt?.state !== "accepted" ||
              receipt.receipt.disposition !== "applied" ||
              receipt.receipt.runId !== input.runId ||
              receipt.receipt.inputId !== id ||
              receipt.operation?.method !== "input.inject" ||
              receipt.operation.operationThreadId !== current.scope.threadId ||
              receipt.operation.targetRunId !== input.runId ||
              canonical(receipt.operation.resolved.namespace) !== namespace ||
              receipt.operation.resolved.namespaceGeneration !== epoch
            )
              throw new ProtocolError("approval_changed")
          }
        }
      }
      await verifyAccepted(tx)
      const tasks = new Map<string, Set<string>>(),
        resumes = new Map<string, Map<string, unknown>>(),
        lineage = new Map<string, Set<string>>()
      const checkpointIds = new Set([
        thread.headCheckpointId,
        ...pending.map((row) => row.proposal!.nativeBinding!.checkpointId),
      ])
      const decisions = new Map(
        pending.map((row) => [row.proposal!.nativeBinding!.interruptId, row.decision]),
      )
      const propagated = new Map<string, Set<string>>(),
        namespaces = await tx.nativeNamespaces.list()
      for (const item of pending) {
        let namespace = item.namespace,
          childId = item.proposal!.nativeBinding!.checkpointId
        while (namespace.length) {
          const binding = namespaces.find(
            (record) =>
              record.runId === previousRunId &&
              canonical(record.namespace) === canonical(namespace),
          )
          if (!binding || binding.status !== "parked" || binding.checkpointId !== childId)
            throw new ProtocolError("approval_changed")
          const parent = await tx.checkpoints.get(binding.parentCheckpointId),
            parentTask = namespace.at(-1)!.split(":").at(-1)!
          if (!parent || canonical(parent.namespace) !== canonical(namespace.slice(0, -1)))
            throw new ProtocolError("approval_changed")
          let matched = false
          for (const write of this.payload(parent).writes) {
            if (
              write.kind !== "execution" ||
              write.ownerRunId !== previousRunId ||
              write.taskId !== parentTask ||
              write.channel !== "__interrupt__"
            )
              continue
            const interrupt = await this.nativeInterrupt(write.value)
            const { interruptId, grant: _grant, ...request } = interrupt.value
            if (
              interrupt.id === item.proposal!.nativeBinding!.interruptId &&
              interruptId === item.input.data.interruptId &&
              canonical(request) ===
                canonical((item.input.data.payload as { request: unknown }).request)
            )
              matched = true
          }
          if (!matched) throw new ProtocolError("approval_changed")
          checkpointIds.add(binding.parentCheckpointId)
          const selected = propagated.get(binding.parentCheckpointId) ?? new Set<string>()
          selected.add(parentTask)
          propagated.set(binding.parentCheckpointId, selected)
          childId = binding.parentCheckpointId
          namespace = namespace.slice(0, -1)
        }
      }
      for (const id of checkpointIds) {
        const row = await tx.checkpoints.get(id),
          sourceIndex = row?.ownerRunId ? chain.indexOf(row.ownerRunId) : -1
        if (!row || sourceIndex < 1) throw new ProtocolError("approval_changed")
        const ancestors = new Set(chain.slice(1, sourceIndex + 1))
        lineage.set(id, ancestors)
        tasks.set(id, new Set(propagated.get(id)))
        resumes.set(id, new Map(decisions))
        const checkpoint = this.payload(row).checkpoint
        const ids = checkpoint
          ? ((await this.decode(checkpoint)) as Checkpoint).channel_values._b4AppliedInputIds
          : undefined
        if (
          ids !== undefined &&
          (!Array.isArray(ids) ||
            ids.some((value) => typeof value !== "string") ||
            new Set(ids).size !== ids.length)
        )
          throw new ProtocolError("approval_changed")
        if (Array.isArray(ids) && ids.length) {
          const key = canonical(row.namespace),
            prior = markers.get(key)
          if (prior && (prior.checkpointId !== id || canonical(prior.ids) !== canonical(ids)))
            throw new ProtocolError("approval_changed")
          markers.set(key, { checkpointId: id, ids: [...ids], owners: new Set(chain.slice(1)) })
        }
        for (const item of pending) {
          const binding = item.proposal!.nativeBinding!
          if (binding.checkpointId === id && canonical(row.namespace) === canonical(item.namespace))
            tasks.get(id)!.add(binding.taskId)
        }
      }
      const slots = cuts
        .flatMap((cut) => cut.pending)
        .filter((item) => {
          const binding = item.proposal!.nativeBinding!
          return tasks.get(binding.checkpointId)?.has(binding.taskId)
        })
      await verifyAccepted(tx)
      let stoppedSource:
        | {
            readonly checkpointId: string
            readonly checkpointOwnerRunId: string
            readonly stoppedSource: RuntimeStoppedSourceProof
          }
        | undefined
      if (administrative) {
        const head = await tx.checkpoints.get(thread.headCheckpointId)
        const physical = head?.ownerRunId,
          index = physical ? chain.indexOf(physical) : -1
        if (!head || head.namespace.length || index < 1) throw new ProtocolError("approval_changed")
        const path: RuntimeStoppedSourceProof["path"][number][] = []
        for (const cut of cuts.slice(0, index)) {
          const segment = await tx.runs.get(cut.receipt.receipt.runId)
          if (
            !segment ||
            segment.preRunCheckpointId !== thread.headCheckpointId ||
            (path.length &&
              (segment.metadata.phase !== "settled" ||
                segment.metadata.continuation !== "closed" ||
                segment.metadata.reason !== "permission" ||
                !segment.unwoundAt ||
                segment.ownershipLoss))
          )
            throw new ProtocolError("approval_changed")
          path.push({
            runId: segment.run.run_id,
            previousRunId: segment.metadata.previousRunId!,
            receiptId: cut.receipt.receiptId,
            selectedHead: segment.preRunCheckpointId,
            protectedSource: null,
          })
        }
        stoppedSource = {
          checkpointId: thread.headCheckpointId,
          checkpointOwnerRunId: physical!,
          stoppedSource: { v: 1, ...witness!, creatorMethod: "input.respond", path },
        }
      }
      return {
        proof: {
          tasks,
          resumes,
          lineage,
          markers,
          assert: verifyAccepted,
        } satisfies ContinuationProof,
        pending: slots,
        resume: Object.fromEntries(decisions),
        stoppedSource,
      }
    })
    this.continuation = prepared.proof
    this.acceptedResolver = administrative
      ? undefined
      : (request: PermissionContinuationRequest): Promise<boolean | undefined> =>
          this.options.store.transaction(async (tx) => {
            await prepared.proof.assert(tx)
            if (request.runId !== this.options.runId) return false
            const intended = prepared.pending.filter(
              (row) =>
                row.proposal!.nativeBinding!.checkpointId === request.checkpointId &&
                row.proposal!.nativeBinding!.checkpointNs === request.checkpointNs &&
                row.proposal!.nativeBinding!.taskId === request.nativeTaskId &&
                row.proposal!.nativeBinding!.interruptIndex === request.interruptIndex,
            )
            if (!intended.length) {
              const previous = prepared.pending.filter(
                (row) =>
                  row.proposal!.nativeBinding!.checkpointNs === request.checkpointNs &&
                  row.proposal!.nativeBinding!.taskId === request.nativeTaskId,
              )
              return previous.some(
                (row) => row.proposal!.nativeBinding!.interruptIndex >= request.interruptIndex,
              )
                ? false
                : undefined
            }
            return intended.some(
              (row) =>
                canonical((row.input.data.payload as { request: unknown }).request) ===
                  canonical(request.request) &&
                canonical(row.proposal!.value) === canonical(request.protectedProposal) &&
                canonical(row.proposal!.rule) === canonical(request.rule),
            )
          })
    return {
      resume: prepared.resume,
      resolve: (request: PermissionContinuationRequest) =>
        administrative ? Promise.resolve(false) : this.resolvePermission(request),
      stoppedSource: prepared.stoppedSource,
    }
  }
  async deleteThread(_threadId: string): Promise<void> {
    throw new ProtocolError("not_supported")
  }
}
