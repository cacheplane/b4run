import { type ChildProcess, fork } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { createSourceBundle, readSourceFile } from "@b4run/workspace/node"
import { afterEach, expect, it } from "vitest"
import { makeWorkspaceAssociationStore } from "../src/workspace/association-store.ts"
import { openWorkspaceInstallation } from "../src/workspace/installation.ts"
import { makeWorkspaceSourceStore } from "../src/workspace/source-store.ts"

const roots: string[] = []
const owners: ReturnType<typeof openWorkspaceInstallation>[] = []
const bundle = createSourceBundle([
  { path: "bytes.bin", bytes: Uint8Array.of(0, 255, 128), executable: false },
])
function root() {
  const path = mkdtempSync(join(tmpdir(), "b4-installation-"))
  roots.push(path)
  mkdirSync(join(path, ".b4/workspaces"), { recursive: true })
  return path
}
function open(path: string) {
  const owner = openWorkspaceInstallation(path)
  owners.push(owner)
  return owner
}
function edit(path: string, name: string, operation: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(join(path, ".b4/workspaces", `${name}.sqlite`))
  try {
    db.exec("PRAGMA synchronous=FULL")
    operation(db)
  } finally {
    db.close()
  }
}
function admission(path: string, id: string = randomUUID(), phase = "initializing", version = 1) {
  edit(path, "admission", (db) => {
    db.exec("CREATE TABLE workspace_admission(version INTEGER, installation_id TEXT, phase TEXT)")
    db.prepare("INSERT INTO workspace_admission VALUES (?,?,?)").run(version, id, phase)
  })
  return id
}
function state(path: string, id: string) {
  edit(path, "state", (db) => {
    db.exec("CREATE TABLE workspace_installation(version INTEGER, installation_id TEXT)")
    db.prepare("INSERT INTO workspace_installation VALUES (2,?)").run(id)
    const sources = makeWorkspaceSourceStore(db)
    sources.put(bundle)
    makeWorkspaceAssociationStore(db, sources)
  })
}
afterEach(() => {
  for (const owner of owners.splice(0)) owner.close()
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})
it("retains installation identity and exact binary source bytes across reopen", () => {
  const path = root()
  const owner = open(path)
  expect(owner.installationId).toMatch(/^[0-9a-f-]{36}$/)
  owner.sources.put(bundle)
  owner.close()
  const reopened = open(path)
  expect(reopened.installationId).toBe(owner.installationId)
  const restored = reopened.sources.get(bundle.digest)
  expect(restored).toEqual(bundle)
  if (!restored) throw new Error("Missing restored source")
  expect(readSourceFile(restored, "bytes.bin")).toEqual(Uint8Array.of(0, 255, 128))
})
it("holds admission until idempotent close and rejects use after close", () => {
  const path = root()
  const owner = open(path)
  expect(() => open(path)).toThrow()
  owner.close()
  owner.close()
  expect(() => owner.sources.get(bundle.digest)).toThrow(/closed/i)
  expect(() => owner.sources.put(bundle)).toThrow(/closed/i)
  expect(open(path).installationId).toBe(owner.installationId)
})
it.each(["absent", "empty", "complete"])("resumes initializing admission with %s state", (mode) => {
  const path = root()
  const id = admission(path)
  if (mode === "empty") edit(path, "state", () => {})
  if (mode === "complete") state(path, id)
  expect(open(path).installationId).toBe(id)
  if (mode === "complete") expect(owners.at(-1)?.sources.get(bundle.digest)).toEqual(bundle)
})
it("recovers an empty admission left before metadata commit", () => {
  const path = root()
  edit(path, "admission", (db) => {
    db.exec("BEGIN; CREATE TABLE workspace_admission(version INTEGER); ROLLBACK")
  })
  expect(open(path).installationId).toBeTruthy()
})
it.each([
  "absent",
  "empty",
  "wrong-id",
  "missing-sources",
  "partial-sources",
  "missing-identity",
  "wrong-version",
])("rejects ready admission with %s state", (mode) => {
  const path = root()
  const id = admission(path, randomUUID(), "ready")
  if (mode === "empty") edit(path, "state", () => {})
  if (!["absent", "empty"].includes(mode)) {
    state(path, mode === "wrong-id" ? randomUUID() : id)
    edit(path, "state", (db) => {
      if (mode === "missing-sources")
        db.exec("DROP TABLE workspace_sources; DROP TABLE workspace_source_schema")
      if (mode === "partial-sources") db.exec("DROP TABLE workspace_sources")
      if (mode === "missing-identity") db.exec("DROP TABLE workspace_installation")
      if (mode === "wrong-version") db.exec("UPDATE workspace_installation SET version=99")
    })
  }
  expect(() => open(path)).toThrow()
  if (mode === "absent") expect(existsSync(join(path, ".b4/workspaces/state.sqlite"))).toBe(false)
})
it.each(["absent", "empty"])("rejects %s admission when state already exists", (mode) => {
  const path = root()
  state(path, randomUUID())
  if (mode === "empty") edit(path, "admission", () => {})
  expect(() => open(path)).toThrow()
})
it.each(["uuid", "phase", "version", "duplicate", "unrelated"])(
  "rejects malformed admission: %s",
  (mode) => {
    const path = root()
    if (mode === "unrelated") edit(path, "admission", (db) => db.exec("CREATE TABLE unrelated(x)"))
    else {
      admission(
        path,
        mode === "uuid" ? "no" : randomUUID(),
        mode === "phase" ? "broken" : "initializing",
        mode === "version" ? 2 : 1,
      )
      if (mode === "duplicate")
        edit(path, "admission", (db) =>
          db.exec("INSERT INTO workspace_admission SELECT * FROM workspace_admission"),
        )
    }
    expect(() => open(path)).toThrow()
  },
)
it.each(["unrelated", "incomplete", "mismatch"])(
  "refuses initializing admission with %s state",
  (mode) => {
    const path = root()
    const id = admission(path)
    if (mode === "unrelated") edit(path, "state", (db) => db.exec("CREATE TABLE unrelated(x)"))
    else {
      state(path, mode === "mismatch" ? randomUUID() : id)
      if (mode === "incomplete")
        edit(path, "state", (db) => db.exec("DROP TABLE workspace_source_schema"))
    }
    expect(() => open(path)).toThrow()
  },
)
it.each([
  ".b4",
  ".b4/workspaces",
  ".b4/workspaces/admission.sqlite",
  ".b4/workspaces/state.sqlite",
])("rejects symlink descendant %s", (relative) => {
  const path = root()
  const target = root()
  const link = join(path, relative)
  rmSync(link, { recursive: true, force: true })
  if (relative.endsWith("sqlite")) writeFileSync(join(target, "file"), "")
  symlinkSync(relative.endsWith("sqlite") ? join(target, "file") : target, link)
  expect(() => open(path)).toThrow(/symlink/i)
})
it.each(["admission", "state"])("rejects nonregular %s database paths", (name) => {
  const path = root()
  mkdirSync(join(path, ".b4/workspaces", `${name}.sqlite`))
  expect(() => open(path)).toThrow()
})
it("canonicalizes app root aliases to the same ownership guard", () => {
  const path = root()
  const alias = join(root(), "alias")
  symlinkSync(path, alias)
  const owner = open(alias)
  expect(() => open(path)).toThrow()
  owner.close()
  expect(open(path).installationId).toBe(owner.installationId)
})

function message(child: ChildProcess): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Child IPC deadline exceeded")), 10_000)
    const onExit = () => finish(new Error("Child exited before IPC response"))
    const onError = (error: Error) => finish(error)
    const onMessage = (value: Record<string, string>) => finish(undefined, value)
    function finish(error?: Error, value?: Record<string, string>) {
      clearTimeout(timer)
      child.off("exit", onExit)
      child.off("error", onError)
      child.off("message", onMessage)
      if (error) reject(error)
      else if (value) resolve(value)
      else reject(new Error("Missing child IPC response"))
    }
    child.once("exit", onExit)
    child.once("error", onError)
    child.once("message", onMessage)
  })
}
function exit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit)
      reject(new Error("Child exit deadline exceeded"))
    }, 10_000)
    function onExit() {
      clearTimeout(timer)
      resolve()
    }
    child.once("exit", onExit)
  })
}
it("excludes another process and recovers committed UUID and bytes after SIGKILL", async () => {
  const path = root()
  const children: ChildProcess[] = []
  const worker = fileURLToPath(
    new URL("../../../test/fixtures/workspace-installation-worker.ts", import.meta.url),
  )
  function launch() {
    const child = fork(worker, [path], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    })
    children.push(child)
    return child
  }
  try {
    const holder = launch()
    const owned = await message(holder)
    expect(owned.status).toBe("owned")
    expect(() => open(path)).toThrow()
    const contender = launch()
    const stopped = exit(contender)
    expect((await message(contender)).status).toBe("rejected")
    await stopped
    const killed = exit(holder)
    holder.kill("SIGKILL")
    await killed
    const recovered = open(path)
    expect(recovered.installationId).toBe(owned.installationId)
    if (!owned.digest) throw new Error("Child omitted source digest")
    expect(recovered.sources.get(owned.digest)).toEqual(bundle)
  } finally {
    await Promise.all(
      children.map(async (child) => {
        const stopped = exit(child)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        await stopped
      }),
    )
  }
}, 30_000)
it("does not confuse sqlite-like application tables with internal SQLite objects", () => {
  const path = root()
  edit(path, "admission", (db) => db.exec("CREATE TABLE sqliteXcustom(value)"))
  expect(() => open(path)).toThrow(/admission/i)
})
it("releases admission after state validation failure so repaired state can reopen", () => {
  const path = root()
  const id = admission(path, randomUUID(), "ready")
  expect(() => open(path)).toThrow()
  state(path, id)
  expect(open(path).installationId).toBe(id)
})

it("owns durable associations and refuses association operations after close", async () => {
  const { createWorkspaceIntent } = await import("@b4run/workspace/node")
  const path = root()
  const owner = open(path)
  owner.sources.put(bundle)
  const intent = createWorkspaceIntent({
    operationId: randomUUID(),
    installationId: owner.installationId,
    threadId: "owned-thread",
    definition: { version: 1, source: bundle, environmentLinks: [] },
    environment: {
      binding: { provider: "fake", scope: "local", account: "local" },
      identity: "env",
    },
  })
  owner.associations.create(intent)
  owner.close()
  expect(() => owner.associations.get(intent.threadId)).toThrow(/closed/i)
  expect(open(path).associations.get(intent.threadId)?.intent).toEqual(intent)
})
