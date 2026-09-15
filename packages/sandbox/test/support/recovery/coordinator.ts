import { randomUUID } from "node:crypto"
import { makeManifest } from "./manifest.ts"
import type { RecoveryStore } from "./store.ts"
import type {
  Attempt,
  FaultHook,
  RecoveryResources,
  ResourceInspection,
  SourceManifest,
  WorkspaceRecord,
} from "./types.ts"

export class RecoveryError extends Error {
  readonly code: "conflict" | "unavailable" | "lost-workspace" | "not-found"
  constructor(code: RecoveryError["code"], message: string) {
    super(message)
    this.name = "RecoveryError"
    this.code = code
  }
}
export interface RecoverySession {
  record: WorkspaceRecord
  sessionId: string
}

/** Test-only single-coordinator protocol. The store owns process admission. */
export class RecoveryCoordinator {
  private readonly store: RecoveryStore
  private readonly resources: RecoveryResources
  private busy = false
  private readonly fault: FaultHook
  constructor(store: RecoveryStore, resources: RecoveryResources, fault: FaultHook = () => {}) {
    this.store = store
    this.resources = resources
    this.fault = fault
  }

  create(logicalId: string, source: SourceManifest, imageId: string): Promise<RecoverySession> {
    return this.exclusive(() => this.createInternal(logicalId, source, imageId))
  }
  reconnect(logicalId: string): Promise<RecoverySession> {
    return this.exclusive(() => this.reconnectInternal(logicalId))
  }
  release(logicalId: string): Promise<void> {
    return this.exclusive(() => this.releaseInternal(logicalId))
  }
  destroy(logicalId: string): Promise<void> {
    return this.exclusive(() => this.destroyInternal(logicalId))
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new RecoveryError("unavailable", "Coordinator lifecycle operation is busy")
    this.busy = true
    try {
      return await operation()
    } finally {
      this.busy = false
    }
  }

  private async createInternal(
    logicalId: string,
    source: SourceManifest,
    imageId: string,
  ): Promise<RecoverySession> {
    const canonical = makeManifest(source.files, source.dependencyTarget)
    if (canonical.digest !== source.digest)
      throw new RecoveryError("conflict", "Source digest does not match its manifest")
    if (!logicalId || !imageId)
      throw new RecoveryError(
        "conflict",
        "Logical workspace and resolved image identity are required",
      )
    const existing = this.store.get(logicalId)
    if (existing) {
      if (existing.source.digest !== canonical.digest || existing.imageId !== imageId)
        throw new RecoveryError("conflict", "Conflicting workspace creation intent")
      return this.reconnectInternal(logicalId)
    }
    if (await this.resources.hasResources(this.store.installationId, logicalId))
      throw new RecoveryError("conflict", "Workspace resources exist without metadata")
    const record: WorkspaceRecord = {
      logicalId,
      source: canonical,
      imageId,
      status: "preparing",
      attempt: this.newAttempt(logicalId, imageId),
    }
    this.store.insert(record)
    return this.prepare(record)
  }

  private async reconnectInternal(logicalId: string): Promise<RecoverySession> {
    const record = this.required(logicalId)
    if (record.status === "deleting" || record.status === "deleted")
      throw new RecoveryError("conflict", `Workspace is ${record.status}`)
    if (record.status === "ready") return this.attach(record)
    // Verify persisted input before provisioning a replacement; defaults are irrelevant.
    if (
      makeManifest(record.source.files, record.source.dependencyTarget).digest !==
      record.source.digest
    )
      throw new RecoveryError("conflict", "Stored source manifest digest mismatch")
    await this.removeOwned(record)
    const replacement: WorkspaceRecord = {
      ...record,
      attempt: this.newAttempt(record.logicalId, record.imageId),
    }
    this.save(replacement, record)
    return this.prepare(replacement)
  }

  private async releaseInternal(logicalId: string): Promise<void> {
    const record = this.required(logicalId)
    if (record.status !== "ready")
      throw new RecoveryError("conflict", `Workspace is ${record.status}`)
    await this.inspect(record)
    await this.resources.release(record.attempt)
    const state = await this.inspect(record)
    if (state.session) throw new RecoveryError("unavailable", "Session removal is unconfirmed")
    delete record.attempt.sessionId
    this.save(record)
  }

  private async destroyInternal(logicalId: string): Promise<void> {
    let record = this.required(logicalId)
    if (record.status === "deleted") return
    if (record.status !== "deleting") {
      const deleting: WorkspaceRecord = { ...record, status: "deleting" }
      this.save(deleting, record)
      record = deleting
      await this.fault("deleting", record.attempt)
    }
    await this.removeOwned(record)
    this.save({ ...record, status: "deleted" }, record)
  }

  private newAttempt(logicalId: string, imageId: string): Attempt {
    const generationId = randomUUID()
    const prefix = `b4-recovery-${generationId}`
    return {
      installationId: this.store.installationId,
      logicalId,
      generationId,
      imageId,
      volumeName: `${prefix}-data`,
      preparerName: `${prefix}-prepare`,
      sessionName: `${prefix}-session`,
    }
  }

  private async prepare(record: WorkspaceRecord): Promise<RecoverySession> {
    await this.fault("intent", record.attempt)
    // Failures intentionally retain the attempt. Recovery first resolves its physical state.
    await this.resources.prepare(record.attempt, record.source, record.imageId)
    this.save(record)
    await this.fault("validated", record.attempt)
    await this.inspect(record)
    await this.resources.stop(record.attempt)
    const stopped = await this.inspect(record)
    if (!stopped.volume || !stopped.preparer || stopped.preparer.running || stopped.session)
      throw new RecoveryError(
        "unavailable",
        "Preparation termination and storage are not confirmed",
      )
    await this.fault("stopped", record.attempt)
    const ready: WorkspaceRecord = { ...record, status: "ready" }
    this.save(ready, record)
    await this.fault("published", ready.attempt)
    return this.attach(ready)
  }

  private async attach(record: WorkspaceRecord): Promise<RecoverySession> {
    const state = await this.inspect(record)
    if (!state.volume)
      throw new RecoveryError("lost-workspace", "Selected workspace storage is missing")
    if (state.preparer?.running)
      throw new RecoveryError("unavailable", "Selected generation has an active preparer")
    // Release may have removed compute before the host committed its pin removal.
    // Commit confirmed absence before another create can lose its acknowledgement.
    if (!state.session && record.attempt.sessionId !== undefined) {
      delete record.attempt.sessionId
      this.save(record)
    }
    const sessionId = await this.resources.attach(record.attempt, record.imageId)
    record.attempt.sessionId = sessionId
    this.save(record)
    return { record, sessionId }
  }

  private async removeOwned(record: WorkspaceRecord): Promise<void> {
    await this.inspect(record)
    await this.resources.stop(record.attempt)
    const stopped = await this.inspect(record)
    if (stopped.preparer?.running || stopped.session?.running)
      throw new RecoveryError("unavailable", "Compute termination is unconfirmed")
    await this.resources.destroy(record.attempt)
    const removed = await this.resources.inspect(record.attempt)
    if (removed.volume || removed.preparer || removed.session)
      throw new RecoveryError("unavailable", "Resource removal is unconfirmed")
  }

  private async inspect(record: WorkspaceRecord): Promise<ResourceInspection> {
    const state = await this.resources.inspect(record.attempt)
    for (const [field, physical] of [
      ["preparerId", state.preparer],
      ["sessionId", state.session],
    ] as const) {
      if (!physical) continue
      const pinned = record.attempt[field]
      if (pinned && pinned !== physical.id)
        throw new RecoveryError("conflict", `Physical ${field} identity mismatch`)
      record.attempt[field] = physical.id
    }
    this.save(record)
    return state
  }

  private required(logicalId: string): WorkspaceRecord {
    const record = this.store.get(logicalId)
    if (!record)
      throw new RecoveryError(
        "not-found",
        "Workspace metadata is missing; refusing to adopt physical resources",
      )
    return record
  }
  private save(record: WorkspaceRecord, previous = record): void {
    this.store.update(record, {
      status: previous.status,
      generationId: previous.attempt.generationId,
    })
  }
}
