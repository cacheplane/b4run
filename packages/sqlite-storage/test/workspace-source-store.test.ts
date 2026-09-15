import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { captureWorkspaceSource, createSourceBundle, readSourceFile } from "@b4run/workspace/node"
import { afterEach, describe, expect, it } from "vitest"
import { makeWorkspaceSourceStore } from "../src/workspace/source-store.ts"

const connections: DatabaseSync[] = []
const directories: string[] = []
function database(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path)
  connections.push(db)
  db.exec("PRAGMA synchronous = FULL")
  return db
}
const source = () =>
  createSourceBundle([
    { path: "TASK.md", bytes: Uint8Array.of(239, 187, 191, 0, 255), executable: false },
  ])
afterEach(() => {
  for (const db of connections.splice(0)) if (db.isOpen) db.close()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("workspace source store", () => {
  it("recovers captured source after the application checkout is removed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "b4-captured-source-"))
    directories.push(dir)
    const appRoot = join(dir, "app")
    mkdirSync(join(appRoot, "project"), { recursive: true })
    writeFileSync(join(appRoot, "project", "index.bin"), Uint8Array.of(0, 255, 128))
    writeFileSync(join(appRoot, "TASK.md"), "\uFEFFRepair the fixture.\n")
    const captured = await captureWorkspaceSource(appRoot, {
      directory: "project",
      include: ["index.bin"],
      files: [{ path: "TASK.md", file: "TASK.md" }],
    })
    const path = join(dir, "state.sqlite")
    const db = database(path)
    makeWorkspaceSourceStore(db).put(captured)
    db.close()
    rmSync(appRoot, { recursive: true })
    const restored = makeWorkspaceSourceStore(database(path)).get(captured.digest)
    if (!restored) throw new Error("Captured source was not retained")
    expect(restored).toEqual(captured)
    expect(readSourceFile(restored, "index.bin")).toEqual(Uint8Array.of(0, 255, 128))
    expect(
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(readSourceFile(restored, "TASK.md")),
    ).toBe("\uFEFFRepair the fixture.\n")
  })
  it("retains exact bytes after close and reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "b4-source-store-"))
    directories.push(dir)
    const path = join(dir, "state.sqlite")
    const db = database(path)
    const bundle = source()
    makeWorkspaceSourceStore(db).put(bundle)
    db.close()
    const restored = makeWorkspaceSourceStore(database(path)).get(bundle.digest)
    expect(restored).toEqual(bundle)
    if (!restored) throw new Error("Source was not retained")
    expect(readSourceFile(restored, "TASK.md")).toEqual(Uint8Array.of(239, 187, 191, 0, 255))
  })
  it("makes duplicate puts idempotent and missing reads side-effect free", () => {
    const db = database()
    const store = makeWorkspaceSourceStore(db)
    expect(store.get("0".repeat(64))).toBeUndefined()
    expect(db.prepare("SELECT count(*) AS n FROM workspace_sources").get()?.n).toBe(0)
    store.put(source())
    store.put(source())
    expect(db.prepare("SELECT count(*) AS n FROM workspace_sources").get()?.n).toBe(1)
  })
  it("composes schema and insertion with an outer transaction", () => {
    const db = database()
    db.exec("BEGIN")
    const store = makeWorkspaceSourceStore(db)
    store.put(source())
    db.exec("ROLLBACK")
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'workspace_sources'").get(),
    ).toBeUndefined()
    const next = makeWorkspaceSourceStore(db)
    db.exec("BEGIN")
    next.put(source())
    db.exec("ROLLBACK")
    expect(next.get(source().digest)).toBeUndefined()
  })
  it("isolates schema versions from thread/checkpoint migrations", () => {
    const db = database()
    db.exec(
      "CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES (99)",
    )
    makeWorkspaceSourceStore(db).put(source())
    expect(db.prepare("SELECT version FROM schema_version").get()?.version).toBe(99)
  })
  it("refuses future or missing versions without adopting existing source data", () => {
    const db = database()
    makeWorkspaceSourceStore(db)
    db.exec("UPDATE workspace_source_schema SET version=2")
    expect(() => makeWorkspaceSourceStore(db)).toThrow(/version/i)
    db.exec("DELETE FROM workspace_source_schema")
    expect(() => makeWorkspaceSourceStore(db)).toThrow(/version/i)
  })
  it.each(["NORMAL", "OFF"])("requires FULL synchronization rather than %s", (level) => {
    const db = database()
    db.exec(`PRAGMA synchronous = ${level}`)
    expect(() => makeWorkspaceSourceStore(db)).toThrow(/FULL/)
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='workspace_sources'").get(),
    ).toBeUndefined()
  })
  it("rejects malformed digests and bundles before insertion", () => {
    const db = database()
    const store = makeWorkspaceSourceStore(db)
    expect(() => store.get("bad")).toThrow(/digest/i)
    expect(() => store.put({ ...source(), digest: "0".repeat(64) })).toThrow(/digest/i)
    expect(db.prepare("SELECT count(*) AS n FROM workspace_sources").get()?.n).toBe(0)
  })
  it.each([
    "{",
    JSON.stringify({ version: 2 }),
    JSON.stringify(source(), null, 2),
    JSON.stringify(source()).replace('{"version":1', '{"version":2,"version":1'),
    JSON.stringify({ ...source(), digest: "0".repeat(64) }),
  ])("rejects corrupt stored payloads and never repairs them on put", (payload) => {
    const db = database()
    const store = makeWorkspaceSourceStore(db)
    const bundle = source()
    db.prepare("INSERT INTO workspace_sources(digest,payload) VALUES (?,?)").run(
      bundle.digest,
      payload,
    )
    expect(() => store.get(bundle.digest)).toThrow()
    expect(() => store.put(bundle)).toThrow()
    expect(db.prepare("SELECT payload FROM workspace_sources").get()?.payload).toBe(payload)
  })
  it("rejects a valid bundle stored under the wrong key", () => {
    const db = database()
    const store = makeWorkspaceSourceStore(db)
    db.prepare("INSERT INTO workspace_sources(digest,payload) VALUES (?,?)").run(
      "0".repeat(64),
      JSON.stringify(source()),
    )
    expect(() => store.get("0".repeat(64))).toThrow(/digest/i)
  })
  it("rejects oversized rows before JSON parsing", () => {
    const db = database()
    const store = makeWorkspaceSourceStore(db)
    db.prepare("INSERT INTO workspace_sources(digest,payload) VALUES (?,zeroblob(?))").run(
      source().digest,
      96 * 1024 * 1024 + 1,
    )
    expect(() => store.get(source().digest)).toThrow(/size|large|limit/i)
  })
  it("refuses writes after the caller weakens synchronization", () => {
    const db = database()
    const store = makeWorkspaceSourceStore(db)
    db.exec("PRAGMA synchronous = NORMAL")
    expect(() => store.put(source())).toThrow(/FULL/)
    expect(store.get(source().digest)).toBeUndefined()
  })
  it("rolls back a failed insertion without rolling back the caller's other work", () => {
    const db = database()
    const store = makeWorkspaceSourceStore(db)
    db.exec(
      "CREATE TABLE caller_data(value INTEGER); CREATE TRIGGER reject_source BEFORE INSERT ON workspace_sources BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
    )
    db.exec("BEGIN; INSERT INTO caller_data VALUES (7)")
    expect(() => store.put(source())).toThrow(/injected failure/)
    db.exec("COMMIT")
    expect(store.get(source().digest)).toBeUndefined()
    expect(db.prepare("SELECT value FROM caller_data").get()?.value).toBe(7)
  })
  it("refuses orphaned source tables without fabricating schema metadata", () => {
    const db = database()
    db.exec("CREATE TABLE workspace_sources(digest TEXT PRIMARY KEY,payload TEXT)")
    expect(() => makeWorkspaceSourceStore(db)).toThrow(/schema/)
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='workspace_source_schema'").get(),
    ).toBeUndefined()
  })
})
