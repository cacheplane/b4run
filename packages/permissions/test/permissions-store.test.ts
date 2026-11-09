import { fork } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createPermissionsStore } from "../src/node.js"

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing required test fixture value")
  return value
}

describe("createPermissionsStore — load + match", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "b4-perms-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  it("returns unknown when no file and no config", async () => {
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    expect(store.match("bash", "npm install")).toBe("unknown")
  })

  it("matches entries from .b4/permissions.json", async () => {
    mkdirSync(join(appRoot, ".b4"), { recursive: true })
    writeFileSync(
      join(appRoot, ".b4", "permissions.json"),
      JSON.stringify({ version: 1, allow: { bash: ["npm install"] }, deny: {} }),
    )
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    expect(store.match("bash", "npm install react")).toBe("allow")
    expect(store.match("bash", "rm -rf /")).toBe("unknown")
  })

  it("merges config + runtime file (both contribute allows)", async () => {
    mkdirSync(join(appRoot, ".b4"), { recursive: true })
    writeFileSync(
      join(appRoot, ".b4", "permissions.json"),
      JSON.stringify({ version: 1, allow: { bash: ["ls"] }, deny: {} }),
    )
    const store = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: { bash: ["npm install"] }, deny: {} },
      mode: "interactive",
    })
    await store.load()
    expect(store.match("bash", "ls -la")).toBe("allow")
    expect(store.match("bash", "npm install react")).toBe("allow")
  })

  it("deny from config wins over allow from runtime file", async () => {
    mkdirSync(join(appRoot, ".b4"), { recursive: true })
    writeFileSync(
      join(appRoot, ".b4", "permissions.json"),
      JSON.stringify({ version: 1, allow: { bash: ["rm"] }, deny: {} }),
    )
    const store = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: {}, deny: { bash: ["rm -rf"] } },
      mode: "interactive",
    })
    await store.load()
    expect(store.match("bash", "rm -rf /tmp")).toBe("deny")
  })

  it("ignores the runtime file in non-interactive mode", async () => {
    mkdirSync(join(appRoot, ".b4"), { recursive: true })
    writeFileSync(
      join(appRoot, ".b4", "permissions.json"),
      JSON.stringify({ version: 1, allow: { bash: ["npm install"] }, deny: {} }),
    )
    const store = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: { bash: ["ls"] }, deny: {} },
      mode: "non-interactive",
    })
    await store.load()
    expect(store.match("bash", "npm install react")).toBe("unknown")
    expect(store.match("bash", "ls -la")).toBe("allow")
  })

  it("ignores everything in bypass mode", async () => {
    mkdirSync(join(appRoot, ".b4"), { recursive: true })
    writeFileSync(
      join(appRoot, ".b4", "permissions.json"),
      JSON.stringify({ version: 1, allow: {}, deny: { bash: ["rm"] } }),
    )
    const store = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: {}, deny: { bash: ["rm"] } },
      mode: "bypass",
    })
    await store.load()
    expect(store.match("bash", "rm -rf /")).toBe("unknown")
  })

  it("throws on malformed JSON in the runtime file", async () => {
    mkdirSync(join(appRoot, ".b4"), { recursive: true })
    writeFileSync(join(appRoot, ".b4", "permissions.json"), "{ not valid json")
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await expect(store.load()).rejects.toThrow(/permissions\.json/i)
  })
})

describe("createPermissionsStore — addAllow", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "b4-perms-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  it("persists an allow entry and updates the in-memory cache atomically", async () => {
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    expect(store.match("bash", "npm install")).toBe("unknown")
    await store.addAllow("bash", "npm install")
    expect(store.match("bash", "npm install react")).toBe("allow")
    const raw = readFileSync(join(appRoot, ".b4", "permissions.json"), "utf8")
    const parsed = JSON.parse(raw)
    expect(parsed.allow.bash).toContain("npm install")
  })

  it("reloads a subagent allow for only the exact parent and name edge", async () => {
    const supportResearcher = JSON.stringify(["/support", "researcher"])
    const financeResearcher = JSON.stringify(["/finance", "researcher"])
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    await store.addAllow("subagent", supportResearcher)

    const reloaded = createPermissionsStore({
      appRoot,
      config: undefined,
      mode: "interactive",
    })
    await reloaded.load()

    expect(reloaded.match("subagent", supportResearcher)).toBe("allow")
    expect(reloaded.match("subagent", financeResearcher)).toBe("unknown")
    expect(reloaded.match("subagent", `${supportResearcher}:extended`)).toBe("unknown")
  })

  it("appends .b4/ to .gitignore on first write (idempotent)", async () => {
    writeFileSync(join(appRoot, ".gitignore"), "node_modules/\n.next/\n")
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    await store.addAllow("bash", "ls")
    const gi = readFileSync(join(appRoot, ".gitignore"), "utf8")
    expect(gi).toContain(".b4/")
    expect(gi).toContain("node_modules/")
  })

  it("creates .gitignore with .b4/ when none exists", async () => {
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    await store.addAllow("bash", "ls")
    const gi = readFileSync(join(appRoot, ".gitignore"), "utf8")
    expect(gi).toBe(".b4/\n")
  })

  it("does not duplicate .b4/ if already in .gitignore", async () => {
    writeFileSync(join(appRoot, ".gitignore"), "node_modules/\n.b4/\n")
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    await store.addAllow("bash", "ls")
    const gi = readFileSync(join(appRoot, ".gitignore"), "utf8")
    expect(gi.match(/\.b4\//g)?.length).toBe(1)
  })

  it("serializes concurrent addAllow calls", async () => {
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    await store.load()
    await Promise.all([
      store.addAllow("bash", "ls"),
      store.addAllow("bash", "pwd"),
      store.addAllow("bash", "cat"),
    ])
    const raw = readFileSync(join(appRoot, ".b4", "permissions.json"), "utf8")
    const parsed = JSON.parse(raw)
    expect([...parsed.allow.bash].sort()).toEqual(["cat", "ls", "pwd"])
  })

  it("exposes the resolved mode", () => {
    const store = createPermissionsStore({ appRoot, config: undefined, mode: "non-interactive" })
    expect(store.mode).toBe("non-interactive")
  })
})

describe("durable remembered-rule intents", () => {
  let appRoot: string
  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "b4-rule-intents-"))
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })
  const open = (root: string) =>
    createPermissionsStore({ appRoot: root, config: undefined, mode: "interactive" })
  it("preserves the existing explicit empty-prefix addAllow contract", async () => {
    const store = open(appRoot)
    await store.addAllow("bash", "")
    expect(store.match("bash", "anything")).toBe("allow")
    expect(
      JSON.parse(readFileSync(join(appRoot, ".b4", "permissions.json"), "utf8")).allow,
    ).toEqual({ bash: [""] })
  })
  it("commits a rule with its idempotency receipt and does not replay it after a later user edit", async () => {
    const a = open(appRoot),
      b = open(appRoot)
    expect(a.rememberedRules).toBeDefined()
    const intent = await required(a.rememberedRules).prepare("operation-1", [
      { tool: "tool", pattern: "send" },
    ])
    expect(await required(a.rememberedRules).apply(intent)).toBe("applied")
    const path = join(appRoot, ".b4", "permissions.json")
    const file = JSON.parse(readFileSync(path, "utf8"))
    file.allow = {}
    writeFileSync(path, JSON.stringify(file))
    expect(await required(b.rememberedRules).apply(intent)).toBe("applied")
    await b.load()
    expect(b.match("tool", "send")).toBe("unknown")
  })
  it("fences an older unapplied intent after another writer changes the scope revision", async () => {
    const a = open(appRoot),
      b = open(appRoot)
    expect(a.rememberedRules).toBeDefined()
    const intent = await required(a.rememberedRules).prepare("operation-2", [
      { tool: "tool", pattern: "send" },
    ])
    await b.addAllow("tool", "inspect")
    expect(await required(a.rememberedRules).apply(intent)).toBe("superseded")
    expect(a.match("tool", "send")).toBe("unknown")
    expect(a.match("tool", "inspect")).toBe("allow")
  })
  it("does not publish a cached allow if durable rule I/O fails", async () => {
    const store = open(appRoot)
    mkdirSync(join(appRoot, ".b4", "permissions.json"), { recursive: true })
    await expect(store.addAllow("tool", "send")).rejects.toThrow()
    expect(store.match("tool", "send")).toBe("unknown")
  })
  it("invalidates a prepared scope when private coordinator metadata is replaced", async () => {
    const store = open(appRoot),
      coordinator = store.rememberedRules
    if (!coordinator) throw new Error("Missing coordinator")
    const intent = await coordinator.prepare("old-scope", [{ tool: "tool", pattern: "send" }])
    const path = join(appRoot, ".b4", "permissions.json"),
      file = JSON.parse(readFileSync(path, "utf8"))
    delete file._b4RuleCoordinator
    writeFileSync(path, JSON.stringify(file))
    expect(await coordinator.apply(intent)).toBe("superseded")
    expect(store.match("tool", "send")).toBe("unknown")
  })
  it("refuses incompatible lock databases without changing their data", async () => {
    mkdirSync(join(appRoot, ".b4"), { recursive: true })
    const path = join(appRoot, ".b4", "permissions.lock.sqlite"),
      db = new DatabaseSync(path)
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE foreign_data(value TEXT); INSERT INTO foreign_data VALUES ('kept')",
    )
    db.close()
    const original = readFileSync(path)
    await expect(open(appRoot).addAllow("tool", "send")).rejects.toThrow(
      "Incompatible permission lock database",
    )
    expect(readFileSync(path)).toEqual(original)
    const after = new DatabaseSync(path)
    try {
      expect(after.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal")
      expect(after.prepare("SELECT value FROM foreign_data").get()?.value).toBe("kept")
    } finally {
      after.close()
    }
  })
  it("serializes actual separate-process file rule writers without losing either rule", async () => {
    const workers = Array.from({ length: 2 }, () =>
      fork(new URL("./fixtures/rule-writer.mjs", import.meta.url), [], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: { PATH: process.env.PATH ?? "" },
      }),
    )
    const exits = workers.map(
      (child) => new Promise<number | null>((resolve) => child.once("exit", resolve)),
    )
    try {
      await Promise.all(
        workers.map(
          (child) =>
            new Promise<void>((resolve, reject) => {
              child.once("message", () => resolve())
              child.once("error", reject)
            }),
        ),
      )
      workers.forEach((child, i) => {
        child.send({ appRoot, pattern: `action-${i}` })
      })
      expect(await Promise.all(exits)).toEqual([0, 0])
      const store = open(appRoot)
      await store.load()
      expect(store.match("tool", "action-0")).toBe("allow")
      expect(store.match("tool", "action-1")).toBe("allow")
    } finally {
      for (const child of workers)
        if (child.exitCode === null && child.signalCode === null) child.kill()
      await Promise.all(exits)
    }
  })
  it("waits asynchronously while another real process holds the compatible lock during inspection", async () => {
    await open(appRoot).addAllow("tool", "initial")
    const spawn = (name: string) =>
      fork(new URL(`./fixtures/${name}.mjs`, import.meta.url), [], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: { PATH: process.env.PATH ?? "" },
      })
    const holder = spawn("rule-lock-holder"),
      writer = spawn("rule-writer")
    const message = (child: typeof holder) =>
      new Promise<void>((resolve, reject) => {
        child.once("message", () => resolve())
        child.once("error", reject)
      })
    const exits = [holder, writer].map(
      (child) => new Promise<number | null>((resolve) => child.once("exit", resolve)),
    )
    try {
      await Promise.all([message(holder), message(writer)])
      const held = message(holder)
      holder.send({ path: join(appRoot, ".b4", "permissions.lock.sqlite") })
      await held
      const started = message(writer)
      writer.send({ appRoot, pattern: "after-lock" })
      await started
      const observation = await Promise.race([
        required(exits[1]).then(() => "exited"),
        new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100)),
      ])
      expect(observation).toBe("waiting")
      holder.send({ release: true })
      expect(await Promise.all(exits)).toEqual([0, 0])
      const store = open(appRoot)
      await store.load()
      expect(store.match("tool", "after-lock")).toBe("allow")
    } finally {
      for (const child of [holder, writer])
        if (child.exitCode === null && child.signalCode === null) child.kill()
      await Promise.all(exits)
    }
  })
})
