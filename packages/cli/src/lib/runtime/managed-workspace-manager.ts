import { randomUUID } from "node:crypto"
import type { WorkspaceInstallation } from "@b4run/sqlite-storage"
import {
  type CapturedWorkspaceDefinition,
  type ManagedWorkspaceProvider,
  type ReadyWorkspace,
  type SandboxHandle,
  type SandboxPolicy,
  type SourceBundle,
  WorkspaceLifecycleError,
  type WorkspaceSession,
  type WorkspaceSessionReference,
} from "@b4run/workspace"
import {
  createWorkspaceIntent,
  readSourceFile,
  verifyCapturedWorkspaceDefinition,
  verifyCreationStatus,
  verifyReadyWorkspace,
} from "@b4run/workspace/node"
/** What admission tells the resolver about the thread. Metadata is loaded lazily: only a thread with no record needs it. */
export interface WorkspaceAdmissionContext {
  /** Loads the thread's stored client metadata. Called only for a thread with no workspace record. */
  readonly metadata?: (signal: AbortSignal) => Promise<Readonly<Record<string, unknown>>>
}

export interface ManagedWorkspaceManagerOptions {
  installation: WorkspaceInstallation
  /** One definition for every thread. Omit when `captureDefinition` decides per thread. */
  definition?: CapturedWorkspaceDefinition
  provider: ManagedWorkspaceProvider
  policy: SandboxPolicy
  idleTimeoutMs: number
  clock?: () => number
  /**
   * Called once per thread, at first admission, to produce that thread's
   * definition. With `definition` also set, this wins and `definition` is
   * NOT a fallback: a resolver that returns nothing is an error, never a
   * silent switch to the app-root capture (development mode recaptures the
   * static definition through this hook). Without `definition`, it is the
   * only source and is required.
   */
  captureDefinition?: (thread: {
    readonly threadId: string
    readonly metadata: Readonly<Record<string, unknown>>
    readonly signal: AbortSignal
  }) => Promise<CapturedWorkspaceDefinition>
}
export interface AdmittedWorkspace {
  readonly ready: ReadyWorkspace
  readonly source: SourceBundle
  readonly readInitialFile: (path: string) => Uint8Array
}

/** B4 association/admission only; physical recovery belongs to the provider. */
export class ManagedWorkspaceManager {
  readonly #options: ManagedWorkspaceManagerOptions
  readonly #definition: CapturedWorkspaceDefinition | undefined
  readonly #sessions = new Map<
    string,
    { session: WorkspaceSession; lastUsedAt: number; workspace: AdmittedWorkspace }
  >()
  readonly #retired = new Map<string, WorkspaceSessionReference>()
  readonly #queues = new Map<string, Promise<unknown>>()
  readonly #backendQueues = new Map<string, Promise<unknown>>()
  readonly #active = new Map<string, number>()
  #closed = false
  #closing = false
  constructor(options: ManagedWorkspaceManagerOptions) {
    this.#options = options
    if (!options.definition && !options.captureDefinition)
      throw new Error("Managed workspaces need a definition or a resolver")
    this.#definition = options.definition
      ? verifyCapturedWorkspaceDefinition(options.definition)
      : undefined
    if (this.#definition) options.installation.sources.put(this.#definition.source)
  }
  #assertOpen() {
    if (this.#closed || this.#closing) throw new Error("Managed workspace manager is closed")
  }
  #now() {
    return (this.#options.clock ?? Date.now)()
  }
  #serial<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(threadId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    this.#queues.set(threadId, next)
    void next
      .finally(() => {
        if (this.#queues.get(threadId) === next) this.#queues.delete(threadId)
      })
      .catch(() => {})
    return next
  }
  retain(threadId: string): () => void {
    this.#assertOpen()
    const state = this.#options.installation.associations.get(threadId)?.state
    if (state === "deleting" || state === "deleted")
      throw new WorkspaceLifecycleError("lost", "Workspace is deleting or deleted")
    this.#active.set(threadId, (this.#active.get(threadId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (this.#active.get(threadId) ?? 1) - 1
      if (count) this.#active.set(threadId, count)
      else this.#active.delete(threadId)
      const entry = this.#sessions.get(threadId)
      if (entry) entry.lastUsedAt = this.#now()
    }
  }
  async getForThread(
    threadId: string,
    signal: AbortSignal,
    context: WorkspaceAdmissionContext = {},
  ): Promise<SandboxHandle> {
    this.#assertOpen()
    const release = this.retain(threadId)
    return this.#serial(threadId, async () => {
      signal.throwIfAborted()
      const { installation, provider, policy } = this.#options
      let record = installation.associations.get(threadId)
      if (record && record.intent.installationId !== installation.installationId)
        throw new WorkspaceLifecycleError("conflict", "Workspace installation identity mismatch")
      if (record?.state === "deleting" || record?.state === "deleted")
        throw new WorkspaceLifecycleError("lost", "Workspace is deleting or deleted")
      if (!record) {
        // The resolver runs exactly here: a thread with no record. Every later
        // admission of this thread finds the record and never reaches this branch.
        let resolved: CapturedWorkspaceDefinition | undefined = this.#definition
        if (this.#options.captureDefinition) {
          const raw: unknown = await context.metadata?.(signal)
          const metadata: Readonly<Record<string, unknown>> =
            raw !== null && typeof raw === "object" && !Array.isArray(raw)
              ? Object.freeze({ ...(raw as Record<string, unknown>) })
              : Object.freeze({})
          resolved = await this.#options.captureDefinition({ threadId, metadata, signal })
        }
        if (!resolved)
          throw new Error(
            this.#options.captureDefinition
              ? "The workspace resolver returned no workspace definition"
              : "Managed workspaces need a definition or a resolver",
          )
        const definition = verifyCapturedWorkspaceDefinition(resolved)
        signal.throwIfAborted()
        installation.sources.put(definition.source)
        const environment = await provider.resolveEnvironment(signal)
        signal.throwIfAborted()
        record = installation.associations.create(
          createWorkspaceIntent({
            installationId: installation.installationId,
            operationId: randomUUID(),
            threadId,
            definition,
            environment,
          }),
        )
      }
      // An admitted session already holds the bundle it was verified with, in memory
      // and frozen. While the association still names that operation and digest, the
      // stored bundle is not consulted again: re-reading and re-hashing it here cost
      // one full bundle verification per filesystem call (see the benchmark in the
      // manager tests). A new session re-reads and re-verifies it below.
      const admitted = this.#sessions.get(threadId)
      if (
        admitted &&
        record.state === "ready" &&
        !this.#retired.has(threadId) &&
        admitted.workspace.ready.reference.operationId === record.intent.operationId &&
        admitted.workspace.source.digest === record.intent.sourceDigest
      ) {
        const expiresAt = record.ready?.provenance.retention.expiresAt
        if (expiresAt && Date.parse(expiresAt) <= this.#now())
          throw new WorkspaceLifecycleError("expired", "Workspace retention deadline has passed")
        admitted.lastUsedAt = this.#now()
        return this.#handle(threadId, admitted.session.handle)
      }
      const source = installation.sources.get(record.intent.sourceDigest)
      if (!source) throw new WorkspaceLifecycleError("lost", "Workspace initial source is missing")
      verifyCapturedWorkspaceDefinition({
        version: 1,
        source,
        environmentLinks: record.intent.environmentLinks,
        ...(record.intent.baseline ? { baseline: record.intent.baseline } : {}),
      })
      const retired = this.#retired.get(threadId)
      if (retired) {
        await provider.release(retired, new AbortController().signal)
        this.#retired.delete(threadId)
      }
      const expiresAt = record.ready?.provenance.retention.expiresAt
      if (expiresAt && Date.parse(expiresAt) <= this.#now())
        throw new WorkspaceLifecycleError("expired", "Workspace retention deadline has passed")
      const cached = this.#sessions.get(threadId)
      if (cached) {
        cached.lastUsedAt = this.#now()
        return this.#handle(threadId, cached.session.handle)
      }
      if (record.state === "creating") {
        const status = verifyCreationStatus(
          await provider.inspectCreation(record.intent, signal),
          record.intent,
        )
        let ready: ReadyWorkspace
        if (status.status === "ready") ready = status.workspace
        else if (status.status === "absent" || status.status === "pending")
          ready = verifyReadyWorkspace(
            await provider.create(record.intent, source, signal),
            record.intent,
          )
        else if (status.status === "failed")
          throw new WorkspaceLifecycleError(status.reason.code, status.reason.message)
        else if (status.status === "unknown")
          throw new WorkspaceLifecycleError("uncertain", status.reason)
        else
          throw new WorkspaceLifecycleError("retryable", "Workspace preparation is still pending")
        record = installation.associations.markReady(threadId, record.revision, ready)
      }
      if (!record.ready) throw new Error("Ready workspace association lacks provenance")
      const ready = verifyReadyWorkspace(record.ready, record.intent)
      if (
        ready.provenance.retention.expiresAt &&
        Date.parse(ready.provenance.retention.expiresAt) <= this.#now()
      )
        throw new WorkspaceLifecycleError("expired", "Workspace retention deadline has passed")
      signal.throwIfAborted()
      const session = await provider.reconnect(ready, policy, signal)
      // Session identity is validated independently of the provider's backend object.
      const validated = verifyReadyWorkspace(
        { reference: session.reference.workspace, provenance: ready.provenance },
        record.intent,
      )
      if (JSON.stringify(validated.reference) !== JSON.stringify(ready.reference))
        throw new WorkspaceLifecycleError(
          "conflict",
          "Provider returned mismatched workspace resource",
        )
      if (
        typeof session.reference.incarnation !== "string" ||
        !session.reference.incarnation.trim() ||
        session.reference.incarnation.length > 1024 ||
        session.handle.threadId !== threadId
      )
        throw new WorkspaceLifecycleError(
          "conflict",
          "Provider returned a mismatched workspace session",
        )
      const operationId = record.intent.operationId
      // The bundle was verified above; index it once rather than re-verifying the
      // whole bundle for every file read. A miss (unknown or non-canonical path)
      // falls through to readSourceFile for its validation and error.
      let initialFiles: Map<string, string> | undefined
      const workspace = Object.freeze({
        ready,
        source,
        readInitialFile: (path: string) => {
          this.#assertOpen()
          const current = installation.associations.get(threadId)
          if (current?.state !== "ready" || current.intent.operationId !== operationId)
            throw new Error("Workspace source is no longer admitted")
          initialFiles ??= new Map(source.files.map((file) => [file.path, file.base64]))
          const base64 = typeof path === "string" ? initialFiles.get(path) : undefined
          if (base64 === undefined) return readSourceFile(source, path)
          return new Uint8Array(Buffer.from(base64, "base64"))
        },
      })
      const admittedSession = {
        handle: session.handle,
        reference: Object.freeze({
          workspace: validated.reference,
          incarnation: session.reference.incarnation,
        }),
      }
      this.#sessions.set(threadId, { session: admittedSession, lastUsedAt: this.#now(), workspace })
      return this.#handle(threadId, session.handle)
    }).finally(release)
  }
  #handle(threadId: string, shape: SandboxHandle): SandboxHandle {
    const wrap = <T extends object>(kind: "filesystem" | "exec", backend: T): T =>
      new Proxy(backend, {
        get: (_target, key) => {
          const original = Reflect.get(backend, key)
          if (typeof original !== "function") return original
          return async (...args: unknown[]) => {
            const context = args.find(
              (value) =>
                value !== null &&
                typeof value === "object" &&
                "signal" in value &&
                value.signal instanceof AbortSignal,
            ) as { signal: AbortSignal } | undefined
            if (!context) throw new Error("Workspace operation requires runtime context")
            const release = this.retain(threadId)
            const previous = this.#backendQueues.get(threadId) ?? Promise.resolve()
            const operation = previous
              .catch(() => {})
              .then(async () => {
                await this.getForThread(threadId, context.signal)
                const entry = this.#sessions.get(threadId)
                if (!entry) throw new Error("Workspace session unavailable")
                const target = entry.session.handle[kind]
                const method = Reflect.get(target, key)
                if (typeof method !== "function")
                  throw new Error("Workspace backend operation unsupported")
                const invalidate = () => {
                  if (this.#sessions.get(threadId) === entry) {
                    this.#retired.set(threadId, entry.session.reference)
                    this.#sessions.delete(threadId)
                  }
                }
                try {
                  const result: unknown = await Reflect.apply(method, target, args)
                  if (
                    context.signal.aborted ||
                    (result !== null &&
                      typeof result === "object" &&
                      "exitCode" in result &&
                      result.exitCode !== 0)
                  )
                    invalidate()
                  return result
                } catch (error) {
                  invalidate()
                  throw error
                }
              })
              .finally(release)
            this.#backendQueues.set(threadId, operation)
            void operation
              .finally(() => {
                if (this.#backendQueues.get(threadId) === operation)
                  this.#backendQueues.delete(threadId)
              })
              .catch(() => {})
            return operation
          }
        },
      })
    return {
      threadId,
      workspaceRoot: shape.workspaceRoot,
      filesystem: wrap("filesystem", shape.filesystem),
      exec: wrap("exec", shape.exec),
    }
  }
  getWorkspace(threadId: string): AdmittedWorkspace | undefined {
    this.#assertOpen()
    const record = this.#options.installation.associations.get(threadId)
    if (record?.state !== "ready") return undefined
    return this.#sessions.get(threadId)?.workspace
  }
  async reapIdle(): Promise<void> {
    this.#assertOpen()
    for (const threadId of [...this.#sessions.keys()])
      await this.#serial(threadId, async () => {
        const entry = this.#sessions.get(threadId)
        if (
          !entry ||
          this.#active.has(threadId) ||
          entry.lastUsedAt > this.#now() - this.#options.idleTimeoutMs
        )
          return
        await this.#options.provider.release(entry.session.reference, new AbortController().signal)
        this.#sessions.delete(threadId)
      })
  }
  async destroyThread(threadId: string): Promise<void> {
    this.#assertOpen()
    if (this.#active.has(threadId))
      throw new WorkspaceLifecycleError("conflict", "Workspace has active execution")
    // Durable exclusion precedes awaiting provider work, closing admission races.
    const record = this.#options.installation.associations.beginDelete(threadId)
    if (!record || record.state === "deleted") return
    await this.#serial(threadId, async () => {
      if (this.#active.has(threadId))
        throw new WorkspaceLifecycleError("conflict", "Workspace has active execution")
      const current = this.#options.installation.associations.get(threadId)
      if (!current || current.state !== "deleting")
        throw new Error("Workspace deletion state changed")
      await this.#options.provider.destroy(
        {
          intent: current.intent,
          ...(current.ready ? { reference: current.ready.reference } : {}),
        },
        new AbortController().signal,
      )
      this.#sessions.delete(threadId)
      this.#retired.delete(threadId)
    })
  }
  async reconcileDeletions(cleanup: (threadId: string) => Promise<void>): Promise<void> {
    this.#assertOpen()
    for (const record of this.#options.installation.associations.list()) {
      if (record.state !== "deleting") continue
      await this.destroyThread(record.intent.threadId)
      await cleanup(record.intent.threadId)
      this.completeDelete(record.intent.threadId)
    }
  }
  completeDelete(threadId: string): void {
    this.#assertOpen()
    const record = this.#options.installation.associations.get(threadId)
    if (record?.state === "deleting")
      this.#options.installation.associations.completeDelete(threadId, record.revision)
  }
  async settle(threadId: string, signal: AbortSignal | undefined): Promise<void> {
    if (!signal?.aborted) return
    await this.#serial(threadId, async () => {
      const entry = this.#sessions.get(threadId)
      const reference = entry?.session.reference ?? this.#retired.get(threadId)
      if (!reference) return
      this.#retired.set(threadId, reference)
      this.#sessions.delete(threadId)
      await this.#options.provider.release(reference, new AbortController().signal)
      this.#retired.delete(threadId)
    })
  }
  async releaseAll(): Promise<void> {
    if (this.#closed) return
    if (this.#active.size)
      throw new WorkspaceLifecycleError(
        "conflict",
        "Cannot release installation while executions remain active",
      )
    this.#closing = true
    try {
      await Promise.allSettled([...this.#queues.values()])
      for (const [id, entry] of this.#sessions) {
        await this.#options.provider.release(entry.session.reference, new AbortController().signal)
        this.#sessions.delete(id)
      }
      for (const [id, reference] of this.#retired) {
        await this.#options.provider.release(reference, new AbortController().signal)
        this.#retired.delete(id)
      }
      this.#options.installation.close()
      this.#closed = true
    } catch (error) {
      this.#closing = false
      throw error
    }
  }
}
