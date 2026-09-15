import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { makeManifest } from "./manifest.ts"
import type { WorkspaceRecord, WorkspaceStatus } from "./types.ts"

export class RecoveryStore {
  readonly installationId: string
  readonly stateDir: string
  private admission: DatabaseSync
  private state: DatabaseSync
  private closed = false
  private constructor(
    stateDir: string,
    admission: DatabaseSync,
    state: DatabaseSync,
    installationId: string,
  ) {
    this.stateDir = stateDir
    this.admission = admission
    this.state = state
    this.installationId = installationId
  }
  static open(directory: string): RecoveryStore {
    mkdirSync(directory, { recursive: true })
    const stateDir = realpathSync(directory)
    const existingAdmission = existsSync(join(stateDir, "admission.sqlite"))
    const existingState = existsSync(join(stateDir, "state.sqlite"))
    if (existingAdmission && !existingState)
      throw new Error("Missing recovery metadata: state.sqlite")
    let admission: DatabaseSync | undefined
    let state: DatabaseSync | undefined
    try {
      admission = new DatabaseSync(join(stateDir, "admission.sqlite"))
      admission.exec("PRAGMA busy_timeout=0")
      try {
        admission.exec("BEGIN IMMEDIATE")
      } catch (error) {
        if ((error as { errcode?: number }).errcode === 5)
          throw new Error("Recovery coordinator busy", { cause: error })
        throw error
      }
      state = new DatabaseSync(join(stateDir, "state.sqlite"))
      state.exec(
        "PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS workspaces (logical_id TEXT PRIMARY KEY, record TEXT NOT NULL)",
      )
      if (!existingState && !existingAdmission) {
        state
          .prepare("INSERT OR IGNORE INTO metadata (key,value) VALUES ('installation',?)")
          .run(randomUUID())
      }
      const row = state.prepare("SELECT value FROM metadata WHERE key='installation'").get() as
        | {
            value: string
          }
        | undefined
      if (!row?.value) throw new Error("Missing recovery metadata: installation identity")
      return new RecoveryStore(stateDir, admission, state, row.value)
    } catch (error) {
      try {
        state?.close()
      } finally {
        admission?.close()
      }
      throw error
    }
  }
  private validate(record: WorkspaceRecord): void {
    const manifest = makeManifest(record.source.files, record.source.dependencyTarget)
    if (manifest.digest !== record.source.digest) throw new Error("Source manifest digest mismatch")
    if (
      !record.logicalId ||
      record.attempt.logicalId !== record.logicalId ||
      record.attempt.installationId !== this.installationId ||
      record.attempt.imageId !== record.imageId ||
      !record.attempt.generationId ||
      !["preparing", "ready", "deleting", "deleted"].includes(record.status)
    )
      throw new Error("Invalid workspace record")
  }
  get(logicalId: string): WorkspaceRecord | undefined {
    const row = this.state
      .prepare("SELECT record FROM workspaces WHERE logical_id=?")
      .get(logicalId) as { record: string } | undefined
    if (!row) return undefined
    const record = JSON.parse(row.record) as WorkspaceRecord
    this.validate(record)
    return record
  }
  private transaction(fn: () => void): void {
    this.state.exec("BEGIN IMMEDIATE")
    try {
      fn()
      this.state.exec("COMMIT")
    } catch (error) {
      this.state.exec("ROLLBACK")
      throw error
    }
  }
  insert(record: WorkspaceRecord): void {
    this.validate(record)
    if (record.status !== "preparing") throw new Error("Initial record must be preparing")
    this.transaction(() => {
      this.state
        .prepare("INSERT INTO workspaces (logical_id,record) VALUES (?,?)")
        .run(record.logicalId, JSON.stringify(record))
    })
  }
  update(
    record: WorkspaceRecord,
    expected: { status: WorkspaceStatus; generationId: string },
  ): void {
    this.validate(record)
    this.transaction(() => {
      const previous = this.get(record.logicalId)
      if (
        !previous ||
        previous.status !== expected.status ||
        previous.attempt.generationId !== expected.generationId
      )
        throw new Error("Workspace state conflict")
      if (previous.source.digest !== record.source.digest || previous.imageId !== record.imageId)
        throw new Error("Workspace intent conflict")
      const transitions: Record<WorkspaceStatus, readonly WorkspaceStatus[]> = {
        preparing: ["preparing", "ready", "deleting"],
        ready: ["ready", "deleting"],
        deleting: ["deleting", "deleted"],
        deleted: [],
      }
      if (!transitions[previous.status].includes(record.status))
        throw new Error("Workspace transition conflict")
      if (
        previous.attempt.generationId !== record.attempt.generationId &&
        (previous.status !== "preparing" || record.status !== "preparing")
      )
        throw new Error("Selected generation conflict")
      if (previous.attempt.generationId === record.attempt.generationId) {
        for (const key of ["volumeName", "preparerName", "sessionName"] as const) {
          if (previous.attempt[key] !== record.attempt[key])
            throw new Error("Resource identity conflict")
        }
        if (
          previous.attempt.preparerId !== undefined &&
          previous.attempt.preparerId !== record.attempt.preparerId
        )
          throw new Error("Preparer identity conflict")
      }
      this.state
        .prepare("UPDATE workspaces SET record=? WHERE logical_id=?")
        .run(JSON.stringify(record), record.logicalId)
    })
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.state.close()
    } finally {
      this.admission.close()
    }
  }
}
