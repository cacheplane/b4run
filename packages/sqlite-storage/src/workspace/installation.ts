import { randomUUID } from "node:crypto"
import { lstatSync, mkdirSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { makeWorkspaceSourceStore, type WorkspaceSourceStore } from "./source-store.js"

interface WorkspaceInstallation {
  readonly installationId: string
  readonly sources: WorkspaceSourceStore
  close(): void
}
interface Admission {
  installationId: string
  phase: "initializing" | "ready"
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function inspect(path: string, directory = false): boolean {
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (!info) return false
  if (info.isSymbolicLink()) throw new Error(`Workspace path must not be a symlink: ${path}`)
  if (directory ? !info.isDirectory() : !info.isFile()) {
    throw new Error(`Invalid workspace ${directory ? "directory" : "database"} path: ${path}`)
  }
  return true
}
function databaseExists(path: string): boolean {
  const exists = inspect(path)
  for (const suffix of ["-journal", "-wal", "-shm"]) inspect(`${path}${suffix}`)
  return exists
}
function objects(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name")
    .all()
    .map((row) => String(row.name))
}
function loadAdmission(db: DatabaseSync): Admission {
  if (objects(db).join(",") !== "workspace_admission")
    throw new Error("Invalid workspace admission schema")
  const rows = db.prepare("SELECT version, installation_id, phase FROM workspace_admission").all()
  const row = rows[0]
  if (
    rows.length !== 1 ||
    row?.version !== 1 ||
    typeof row.installation_id !== "string" ||
    !UUID.test(row.installation_id) ||
    (row.phase !== "initializing" && row.phase !== "ready")
  ) {
    throw new Error("Invalid workspace admission identity, version, or phase")
  }
  return { installationId: row.installation_id, phase: row.phase }
}
function validateState(db: DatabaseSync, id: string): void {
  const names = objects(db)
  if (
    !["workspace_installation", "workspace_source_schema", "workspace_sources"].every((name) =>
      names.includes(name),
    )
  ) {
    throw new Error("Incomplete workspace installation state")
  }
  const rows = db.prepare("SELECT version, installation_id FROM workspace_installation").all()
  if (rows.length !== 1 || rows[0]?.version !== 1 || rows[0]?.installation_id !== id) {
    throw new Error("Workspace installation state identity or version mismatch")
  }
  const versions = db.prepare("SELECT version FROM workspace_source_schema").all()
  if (versions.length !== 1 || versions[0]?.version !== 1)
    throw new Error("Invalid workspace source schema version")
  db.prepare("SELECT digest, payload FROM workspace_sources LIMIT 0").all()
}

/** Local trusted-host owner. The admission writer transaction lasts until close(). */
export function openWorkspaceInstallation(appRoot: string): WorkspaceInstallation {
  let directory = realpathSync(appRoot)
  inspect(directory, true)
  for (const part of [".b4", "workspaces"]) {
    directory = join(directory, part)
    if (!inspect(directory, true)) mkdirSync(directory)
  }
  const admissionPath = join(directory, "admission.sqlite")
  const statePath = join(directory, "state.sqlite")
  databaseExists(admissionPath)
  databaseExists(statePath)
  let admissionDb: DatabaseSync | undefined
  let stateDb: DatabaseSync | undefined
  let closed = false
  function close(): void {
    if (closed) return
    closed = true
    const failures: unknown[] = []
    try {
      stateDb?.close()
    } catch (error) {
      failures.push(error)
    }
    if (admissionDb) {
      try {
        if (admissionDb.isTransaction) admissionDb.exec("ROLLBACK")
      } catch (error) {
        failures.push(error)
      }
      try {
        admissionDb.close()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw new AggregateError(failures, "Workspace installation close failed")
  }
  try {
    admissionDb = new DatabaseSync(admissionPath)
    admissionDb.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; BEGIN IMMEDIATE")
    if (objects(admissionDb).length === 0) {
      if (databaseExists(statePath))
        throw new Error("Workspace state exists without admission metadata")
      admissionDb.exec(
        "CREATE TABLE workspace_admission(version INTEGER, installation_id TEXT, phase TEXT)",
      )
      admissionDb
        .prepare("INSERT INTO workspace_admission VALUES (1,?, 'initializing')")
        .run(randomUUID())
      // Persist intent before creating state; reacquisition may observe another owner.
      admissionDb.exec("COMMIT; BEGIN IMMEDIATE")
    }
    let metadata = loadAdmission(admissionDb)
    const id = metadata.installationId
    const exists = databaseExists(statePath)
    if (metadata.phase === "ready" && !exists)
      throw new Error("Ready workspace installation state is missing")
    stateDb = new DatabaseSync(statePath)
    stateDb.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL")
    if (metadata.phase === "initializing" && objects(stateDb).length === 0) {
      stateDb.exec("BEGIN IMMEDIATE")
      try {
        stateDb.exec("CREATE TABLE workspace_installation(version INTEGER, installation_id TEXT)")
        stateDb.prepare("INSERT INTO workspace_installation VALUES (1,?)").run(id)
        makeWorkspaceSourceStore(stateDb)
        stateDb.exec("COMMIT")
      } catch (error) {
        if (stateDb.isTransaction) stateDb.exec("ROLLBACK")
        throw error
      }
    }
    validateState(stateDb, id)
    const sources = makeWorkspaceSourceStore(stateDb)
    if (metadata.phase === "initializing") {
      admissionDb.exec("UPDATE workspace_admission SET phase='ready'; COMMIT; BEGIN IMMEDIATE")
      metadata = loadAdmission(admissionDb)
      if (metadata.phase !== "ready" || metadata.installationId !== id)
        throw new Error("Workspace admission changed during initialization")
      validateState(stateDb, id)
    }
    function requireOpen(): void {
      if (closed) throw new Error("Workspace installation is closed")
    }
    return {
      installationId: id,
      sources: {
        get(digest) {
          requireOpen()
          return sources.get(digest)
        },
        put(bundle) {
          requireOpen()
          sources.put(bundle)
        },
      },
      close,
    }
  } catch (error) {
    try {
      close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Workspace installation open failed")
    }
    throw error
  }
}
