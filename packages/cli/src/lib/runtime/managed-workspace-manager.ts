import { randomUUID } from "node:crypto"
import type { ThreadPermissionGrants } from "@b4run/permissions"
import type { WorkspaceInstallation } from "@b4run/sqlite-storage"
import {
  type CapturedWorkspaceDefinition,
  inspectWorkspace,
  isWorkspaceInspectionError,
  type ManagedWorkspaceProvider,
  type ReadyWorkspace,
  type SandboxHandle,
  type SandboxPolicy,
  type SourceBundle,
  scopedWorkspaceReader,
  type ThreadSandboxPermissions,
  type ThreadSandboxPolicy,
  type ThreadSandboxRecord,
  type WorkspaceEnvironment,
  WorkspaceLifecycleError,
  type WorkspaceSession,
  type WorkspaceSessionReference,
} from "@b4run/workspace"
import {
  createWorkspaceIntent,
  MAX_THREAD_SANDBOX_RECORD_BYTES,
  readSourceFile,
  threadSandboxRecordBytes,
  verifyCapturedWorkspaceDefinition,
  verifyCreationStatus,
  verifyReadyWorkspace,
  verifyThreadSandboxRecord,
} from "@b4run/workspace/node"
import { threadPolicy } from "./thread-policy.js"
import type {
  ThreadWorkspaceInspectOutcome,
  ThreadWorkspaceInspectRequest,
} from "./workspace-protocol.js"
/** What admission tells the resolver about the thread. Metadata is loaded lazily: only a thread with no record needs it. */
export interface WorkspaceAdmissionContext {
  /** Loads the thread's stored client metadata. Called only for a thread with no workspace record. */
  readonly metadata?: (signal: AbortSignal) => Promise<Readonly<Record<string, unknown>>>
}
/** What a thread-sandbox resolver decided, with its workspace already captured. */
export interface ResolvedThreadSandbox {
  readonly definition: CapturedWorkspaceDefinition
  /** Handed to `provider.resolveImageEnvironment`; the identity it answers is recorded in the intent. */
  readonly image?: string
  readonly policy?: ThreadSandboxPolicy
  /** Replaces the app's allow-list for this thread; recorded, with its grants beside it. */
  readonly permissions?: ThreadSandboxPermissions
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
  /**
   * Called once per thread, at first admission, to decide the thread's whole
   * sandbox. Exclusive with `definition` and `captureDefinition`. Its image
   * and policy are recorded with the association; every later admission,
   * restart included, reads the record and never calls this again.
   */
  resolveThread?: (thread: {
    readonly threadId: string
    readonly metadata: Readonly<Record<string, unknown>>
    readonly signal: AbortSignal
  }) => Promise<ResolvedThreadSandbox>
}
export interface AdmittedWorkspace {
  readonly ready: ReadyWorkspace
  readonly source: SourceBundle
  readonly readInitialFile: (path: string) => Uint8Array
}

function missingRecord(threadId: string): WorkspaceLifecycleError {
  return new WorkspaceLifecycleError(
    "conflict",
    `Thread ${threadId} has no sandbox record: it was admitted before sandbox.thread was configured, or its record was lost. Delete the thread to resolve its sandbox again.`,
  )
}

/**
 * A refusal of a workspace read, as the protocol names it; `undefined` for an
 * error that is nobody's refusal (a backend failure, an unsupported provider),
 * which the caller rethrows.
 */
export function inspectFailure(error: unknown): ThreadWorkspaceInspectOutcome | undefined {
  if (isWorkspaceInspectionError(error)) {
    const message = error.message
    switch (error.code) {
      case "root_missing":
        return {
          ok: false,
          code: "workspace_root_missing",
          message,
          ...(error.detail.root !== undefined ? { root: error.detail.root } : {}),
          ...(error.detail.kind !== undefined ? { kind: error.detail.kind } : {}),
        }
      case "changed":
        return { ok: false, code: "workspace_changed", message }
      case "refused":
        return { ok: false, code: "workspace_inspection_refused", message }
      case "invalid_options":
        return { ok: false, code: "invalid_request", message }
    }
  }
  if (error instanceof WorkspaceLifecycleError) {
    const message = error.message
    switch (error.code) {
      case "lost":
        return { ok: false, code: "workspace_lost", message }
      case "expired":
        return { ok: false, code: "workspace_expired", message }
      case "conflict":
        return { ok: false, code: "workspace_conflict", message }
      case "retryable":
      case "uncertain":
        return { ok: false, code: "workspace_unavailable", message }
      default:
        return undefined
    }
  }
  return undefined
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
    if (options.resolveThread && (options.definition || options.captureDefinition))
      throw new Error(
        "A thread sandbox resolver is exclusive with a workspace definition or workspace resolver",
      )
    if (!options.definition && !options.captureDefinition && !options.resolveThread)
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
  /** The thread's definition and, for a thread-sandbox resolver, its record. */
  async #resolve(
    threadId: string,
    context: WorkspaceAdmissionContext,
    signal: AbortSignal,
  ): Promise<{ definition: CapturedWorkspaceDefinition; sandbox?: ThreadSandboxRecord }> {
    const { captureDefinition, resolveThread } = this.#options
    if (!captureDefinition && !resolveThread) {
      if (!this.#definition) throw new Error("Managed workspaces need a definition or a resolver")
      return { definition: this.#definition }
    }
    const raw: unknown = await context.metadata?.(signal)
    const metadata: Readonly<Record<string, unknown>> =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? Object.freeze({ ...(raw as Record<string, unknown>) })
        : Object.freeze({})
    if (resolveThread) {
      const result = await resolveThread({ threadId, metadata, signal })
      if (!result?.definition)
        throw new Error("The thread sandbox resolver returned no workspace definition")
      // Always a record, even an empty one: "no record" must only ever mean "not admitted in
      // thread mode" or "lost", both of which admission refuses (D11).
      const sandbox = verifyThreadSandboxRecord({
        version: 1,
        ...(result.image !== undefined ? { image: result.image } : {}),
        ...(result.policy !== undefined ? { policy: result.policy } : {}),
        ...(result.permissions !== undefined ? { permissions: result.permissions } : {}),
      })
      // Checked here, before any provider call or source row: a policy can pass every
      // per-field bound and still not fit the stored record.
      if (threadSandboxRecordBytes(sandbox) > MAX_THREAD_SANDBOX_RECORD_BYTES)
        throw new WorkspaceLifecycleError(
          "unsupported",
          `Thread ${threadId}'s sandbox record exceeds ${MAX_THREAD_SANDBOX_RECORD_BYTES} bytes: its policy.env or permissions are too large`,
        )
      return { definition: result.definition, sandbox }
    }
    const definition = await captureDefinition?.({ threadId, metadata, signal })
    if (!definition) throw new Error("The workspace resolver returned no workspace definition")
    return { definition }
  }
  /** The environment for a thread that names its image. A provider without the capability refuses it. */
  async #imageEnvironment(image: string, signal: AbortSignal): Promise<WorkspaceEnvironment> {
    const { provider } = this.#options
    if (typeof provider.resolveImageEnvironment !== "function")
      throw new WorkspaceLifecycleError(
        "unsupported",
        `Managed workspace provider "${provider.name}" cannot run a per-thread image`,
      )
    return provider.resolveImageEnvironment(image, signal)
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
      // An admitted session already holds the bundle it was verified with, in memory
      // and frozen. While the association still names that operation and digest, the
      // stored bundle is not consulted again: re-reading and re-hashing it here cost
      // one full bundle verification per filesystem call (see the benchmark in the
      // manager tests). A new session re-reads and re-verifies it below.
      const admitted = this.#sessions.get(threadId)
      if (
        record &&
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
      // One read of the thread's sandbox record, reused at reconnect below. In thread mode every
      // admitted thread has one ({ version: 1 } at least). A thread with an association and none
      // was admitted before the app switched to sandbox.thread, or its record was lost:
      // re-admitting it would silently run the app's defaults. Refused before any resolver or
      // provider call. (The fast path above only serves a session this check already admitted.)
      let sandboxRecord = record ? installation.threadSandboxes.get(threadId) : undefined
      if (record && this.#options.resolveThread && !sandboxRecord) throw missingRecord(threadId)
      if (!record) {
        // The resolver runs exactly here: a thread with no record. Every later
        // admission of this thread finds the record and never reaches this branch.
        const resolved = await this.#resolve(threadId, context, signal)
        const definition = verifyCapturedWorkspaceDefinition(resolved.definition)
        signal.throwIfAborted()
        // Refused before any provider call: a thread may not widen the app's network.
        threadPolicy(policy, resolved.sandbox?.policy)
        const environment =
          resolved.sandbox?.image === undefined
            ? await provider.resolveEnvironment(signal)
            : await this.#imageEnvironment(resolved.sandbox.image, signal)
        signal.throwIfAborted()
        // Stored only once the environment resolved: a refused image or an
        // unavailable daemon leaves no source row behind.
        installation.sources.put(definition.source)
        record = installation.associations.create(
          createWorkspaceIntent({
            installationId: installation.installationId,
            operationId: randomUUID(),
            threadId,
            definition,
            environment,
          }),
          resolved.sandbox,
        )
        sandboxRecord = resolved.sandbox
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
      const session = await provider.reconnect(
        ready,
        threadPolicy(policy, sandboxRecord?.policy),
        signal,
      )
      // Session identity is validated independently of the provider's backend object.
      const validated = verifyReadyWorkspace(
        {
          reference: session.reference.workspace,
          provenance: ready.provenance,
        },
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
      this.#sessions.set(threadId, {
        session: admittedSession,
        lastUsedAt: this.#now(),
        workspace,
      })
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
  /**
   * The permissions a thread-sandbox resolver recorded for `threadId`, with the
   * store its "Always" grants go to. Undefined for a thread whose record carries
   * no permissions: it runs under the app's store unchanged. In thread mode a
   * thread with no record at all is refused, never given the app's store: its
   * record was lost, or it was never admitted in thread mode (D11).
   */
  threadPermissions(
    threadId: string,
  ):
    | { readonly permissions: ThreadSandboxPermissions; readonly grants: ThreadPermissionGrants }
    | undefined {
    this.#assertOpen()
    const sandboxes = this.#options.installation.threadSandboxes
    const record = sandboxes.get(threadId)
    if (!record) {
      if (this.#options.resolveThread) throw missingRecord(threadId)
      return undefined
    }
    const permissions = record.permissions
    if (!permissions) return undefined
    return {
      permissions,
      grants: {
        list: () => sandboxes.grants(threadId),
        add: (tool, pattern) => sandboxes.addGrant(threadId, tool, pattern),
      },
    }
  }
  getWorkspace(threadId: string): AdmittedWorkspace | undefined {
    this.#assertOpen()
    const record = this.#options.installation.associations.get(threadId)
    if (record?.state !== "ready") return undefined
    return this.#sessions.get(threadId)?.workspace
  }
  /**
   * A bounded, read-only inventory of the thread's published workspace, through
   * the provider's reader: a separate, networkless container that never touches
   * the thread's session. The reader runs as the APP's `security.runAsNonRoot`,
   * the identity the workspace was written under. `retain` makes a concurrent
   * `destroyThread` refuse until the read ends. The caller excludes runs.
   */
  async inspectThread(
    threadId: string,
    request: ThreadWorkspaceInspectRequest,
    signal: AbortSignal,
  ): Promise<ThreadWorkspaceInspectOutcome> {
    this.#assertOpen()
    const { installation, provider, policy } = this.#options
    const record = installation.associations.get(threadId)
    if (!record)
      return {
        ok: false,
        code: "workspace_not_found",
        message: `Thread ${threadId} has no workspace yet: it has not run`,
      }
    if (record.intent.installationId !== installation.installationId)
      return {
        ok: false,
        code: "workspace_conflict",
        message: "Workspace installation identity mismatch",
      }
    if (record.state === "deleting" || record.state === "deleted")
      return {
        ok: false,
        code: "workspace_lost",
        message: `Thread ${threadId}'s workspace is deleted`,
      }
    if (record.state === "creating" || !record.ready)
      return {
        ok: false,
        code: "workspace_not_ready",
        message: `Thread ${threadId}'s workspace is not published yet`,
      }
    const open = provider.openWorkspaceReader
    if (typeof open !== "function")
      throw new WorkspaceLifecycleError(
        "unsupported",
        `Managed workspace provider "${provider.name}" cannot read a workspace`,
      )
    let release: (() => void) | undefined
    try {
      const ready = verifyReadyWorkspace(record.ready, record.intent)
      const expiresAt = ready.provenance.retention.expiresAt
      if (expiresAt && Date.parse(expiresAt) <= this.#now())
        return {
          ok: false,
          code: "workspace_expired",
          message: `Thread ${threadId}'s workspace passed its retention deadline`,
        }
      release = this.retain(threadId)
      const runAsNonRoot = policy.security?.runAsNonRoot
      const inspection = await scopedWorkspaceReader(
        () =>
          open.call(provider, {
            workspace: ready,
            signal,
            ...(runAsNonRoot === undefined ? {} : { runAsNonRoot }),
          }),
        (reader) =>
          inspectWorkspace(reader, {
            signal,
            maxEntries: request.maxEntries,
            maxFileBytes: request.maxFileBytes,
            maxTotalBytes: request.maxTotalBytes,
            excludeRootDirectories: request.excludeRootDirectories,
            expectedRootSymlinks: request.expectedRootSymlinks,
            ...(request.root !== undefined ? { root: request.root } : {}),
          }),
      )
      return {
        ok: true,
        sourceDigest: record.intent.sourceDigest,
        intentDigest: record.intent.digest,
        inspection,
      }
    } catch (error) {
      const refusal = signal.aborted ? undefined : inspectFailure(error)
      if (refusal) return refusal
      throw error
    } finally {
      release?.()
    }
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
