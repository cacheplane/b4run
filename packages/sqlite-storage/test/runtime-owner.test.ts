import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"

function namespaceChecksums(root: string) {
  const directory = join(root, ".b4/agent-protocol/v1")
  return Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((file) => [
        file,
        createHash("sha256")
          .update(readFileSync(join(directory, file)))
          .digest("hex"),
      ]),
  )
}
const roots: string[] = []
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})
it("keeps a single lifetime owner and rejects declared replicas before creating runtime files", async () => {
  expect(
    existsSync(new URL("../src/runtime/index.ts", import.meta.url)),
    "process-verified runtime owner must exist",
  ).toBe(true)
  const { openRuntimeInstallation } = await import("../src/runtime/index.ts")
  const path = mkdtempSync(join(tmpdir(), "b4-owner-"))
  roots.push(path)
  expect(() => openRuntimeInstallation(path, { replicas: 2 })).toThrow(/replica/i)
  expect(existsSync(join(path, ".b4"))).toBe(false)
  const owner = openRuntimeInstallation(path)
  try {
    expect(existsSync(join(path, ".b4/agent-protocol/v1/runtime-owner.sqlite-journal"))).toBe(false)
    expect(() => openRuntimeInstallation(path)).toThrow(/owner/i)
  } finally {
    owner.close()
  }
  const next = openRuntimeInstallation(path)
  expect(next.installationId).toBe(owner.installationId)
  next.close()
})

function response(
  child: import("node:child_process").ChildProcess,
): Promise<{ status: string; installationId?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const onExit = () => finish(new Error("Runtime fixture exited before its response"))
    const onError = (error: Error) => finish(error)
    const onMessage = (value: { status: string; installationId?: string; error?: string }) =>
      finish(undefined, value)
    function finish(
      error?: Error,
      value?: { status: string; installationId?: string; error?: string },
    ) {
      child.off("exit", onExit)
      child.off("error", onError)
      child.off("message", onMessage)
      if (error) reject(error)
      else if (value) resolve(value)
    }
    child.once("exit", onExit)
    child.once("error", onError)
    child.once("message", onMessage)
  })
}
function stopped(child: import("node:child_process").ChildProcess): Promise<void> {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", () => resolve()))
}
it("excludes a real second process, verifies process identity, and recovers after SIGKILL without PID-only recovery", async () => {
  const { fork } = await import("node:child_process")
  const { DatabaseSync } = await import("node:sqlite")
  const { openRuntimeInstallation } = await import("../src/runtime/index.ts")
  const path = mkdtempSync(join(tmpdir(), "b4-owner-process-"))
  roots.push(path)
  const worker = new URL("./fixtures/runtime-worker.ts", import.meta.url)
  const children: import("node:child_process").ChildProcess[] = []
  const launch = () => {
    const child = fork(worker, [path], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    })
    children.push(child)
    return child
  }
  try {
    const holder = launch()
    const owned = await response(holder)
    expect(owned.status).toBe("owned")
    const db = new DatabaseSync(join(path, ".b4/agent-protocol/v1/runtime.sqlite"), {
      readOnly: true,
    })
    const identity = db
      .prepare("SELECT pid,process_start,boot_identity,nonce FROM runtime_owner")
      .get()
    expect(identity?.pid).toBe(holder.pid)
    expect(identity?.process_start).toEqual(expect.any(String))
    expect(String(identity?.process_start).length).toBeGreaterThan(0)
    expect(String(identity?.boot_identity).length).toBeGreaterThan(0)
    expect(identity?.nonce).toMatch(/^[a-f0-9-]{36}$/)
    db.close()
    const beforeContention = namespaceChecksums(path)
    const contender = launch()
    expect(await response(contender)).toMatchObject({
      status: "rejected",
      error: expect.stringMatching(/owner/),
    })
    await stopped(contender)
    expect(() => openRuntimeInstallation(path)).toThrow(/owner/)
    expect(namespaceChecksums(path)).toEqual(beforeContention)
    const killed = stopped(holder)
    holder.kill("SIGKILL")
    await killed
    const recovered = openRuntimeInstallation(path)
    try {
      expect(recovered.installationId).toBe(owned.installationId)
      const read = new DatabaseSync(recovered.path, { readOnly: true })
      const next = read
        .prepare("SELECT pid,process_start,boot_identity,nonce FROM runtime_owner")
        .get()
      read.close()
      expect(next?.pid).toBe(process.pid)
      expect(next?.nonce).not.toBe(identity?.nonce)
    } finally {
      recovered.close()
    }
  } finally {
    await Promise.all(
      children.map(async (child) => {
        const ended = stopped(child)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        await ended
      }),
    )
  }
})
it("rejects an actual cluster worker before opening a runtime namespace", async () => {
  const { fork } = await import("node:child_process")
  const path = mkdtempSync(join(tmpdir(), "b4-owner-cluster-"))
  roots.push(path)
  const child = fork(new URL("./fixtures/runtime-worker.ts", import.meta.url), [path, "cluster"], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  try {
    expect(await response(child)).toMatchObject({
      status: "rejected",
      error: expect.stringMatching(/cluster workers/),
    })
    await stopped(child)
    expect(existsSync(join(path, ".b4"))).toBe(false)
  } finally {
    const ended = stopped(child)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await ended
  }
})
it("preserves receipt checkpoint and journal facts across a crash after commit and before publication", async () => {
  const { fork } = await import("node:child_process")
  const { openRuntimeInstallation } = await import("../src/runtime/index.ts")
  const { bindRuntimeStore, createRuntimeBinding } = await import("../src/runtime/binding.ts")
  const { checkpoint, receipt, run, scope, thread, eventId } = await import(
    "./fixtures/runtime-data.ts"
  )
  const path = mkdtempSync(join(tmpdir(), "b4-owner-crash-"))
  roots.push(path)
  const child = fork(new URL("./fixtures/runtime-worker.ts", import.meta.url), [path, "commit"], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  try {
    const committed = await response(child)
    expect(committed.status).toBe("owned")
    expect(existsSync(join(path, "published"))).toBe(false)
    const ended = stopped(child)
    child.kill("SIGKILL")
    await ended
    const owner = openRuntimeInstallation(path)
    try {
      expect(owner.installationId).toBe(committed.installationId)
      const store = bindRuntimeStore(owner, createRuntimeBinding(owner, scope))
      const snapshot = await store.snapshot()
      expect(snapshot).toMatchObject({
        thread,
        runs: [run],
        checkpoints: [checkpoint],
        receipts: [receipt],
        throughSeq: 1,
      })
      expect(await store.transaction((tx) => tx.journal.read(0))).toMatchObject([
        { eventId, seq: 1 },
      ])
      expect(existsSync(join(path, "published"))).toBe(false)
    } finally {
      owner.close()
    }
  } finally {
    const ended = stopped(child)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await ended
  }
})

it("recovers stale identity metadata even when its PID belongs to a live unrelated process", async () => {
  const { DatabaseSync } = await import("node:sqlite")
  const { openRuntimeInstallation } = await import("../src/runtime/index.ts")
  const path = mkdtempSync(join(tmpdir(), "b4-owner-stale-"))
  roots.push(path)
  const owner = openRuntimeInstallation(path)
  owner.close()
  const db = new DatabaseSync(owner.path)
  db.prepare("UPDATE runtime_owner SET pid=?,process_start=?,boot_identity=?,nonce=?").run(
    process.pid,
    "different-start",
    "different-boot",
    "stale-nonce",
  )
  db.close()
  const recovered = openRuntimeInstallation(path)
  try {
    const read = new DatabaseSync(recovered.path, { readOnly: true })
    expect(
      read.prepare("SELECT process_start,boot_identity,nonce FROM runtime_owner").get(),
    ).not.toMatchObject({
      process_start: "different-start",
      boot_identity: "different-boot",
      nonce: "stale-nonce",
    })
    read.close()
    expect(recovered.installationId).toBe(owner.installationId)
  } finally {
    recovered.close()
  }
})

it.each(["runtime", "owner"] as const)(
  "rejects a crashed %s hot rollback journal without recovery or namespace byte changes",
  async (target) => {
    const { fork } = await import("node:child_process")
    const { copyFileSync } = await import("node:fs")
    const { DatabaseSync } = await import("node:sqlite")
    const { openRuntimeInstallation } = await import("../src/runtime/index.ts")
    const path = mkdtempSync(join(tmpdir(), "b4-owner-hot-journal-"))
    roots.push(path)
    const owner = openRuntimeInstallation(path)
    owner.close()
    const directory = join(path, ".b4/agent-protocol/v1")
    const name = target === "runtime" ? "runtime.sqlite" : "runtime-owner.sqlite"
    const child = fork(
      new URL("./fixtures/runtime-worker.ts", import.meta.url),
      [path, `hot-${target}-journal`],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    )
    try {
      expect(await response(child)).toMatchObject({ status: "hot-journal" })
      const ended = stopped(child)
      child.kill("SIGKILL")
      await ended
      expect(existsSync(join(directory, `${name}-journal`))).toBe(true)
      // A raw main-only copy sees the spilled compatible value, proving the
      // journal—not that main copy—holds the committed incompatible state.
      const inspection = mkdtempSync(join(tmpdir(), "b4-hot-journal-main-"))
      roots.push(inspection)
      const copy = join(inspection, "main.sqlite")
      copyFileSync(join(directory, name), copy)
      const raw = new DatabaseSync(copy, { readOnly: true })
      try {
        expect(
          raw
            .prepare(
              `SELECT version FROM ${target === "runtime" ? "runtime_installation" : "owner_probe"}`,
            )
            .get()?.version,
        ).toBe(target === "runtime" ? 2 : 1)
      } finally {
        raw.close()
      }
      const recoveredCopy = join(inspection, "recover.sqlite")
      copyFileSync(join(directory, name), recoveredCopy)
      copyFileSync(join(directory, `${name}-journal`), `${recoveredCopy}-journal`)
      const recovered = new DatabaseSync(recoveredCopy)
      try {
        expect(
          recovered
            .prepare(
              `SELECT version FROM ${target === "runtime" ? "runtime_installation" : "owner_probe"}`,
            )
            .get()?.version,
        ).toBe(target === "runtime" ? 999 : 2)
      } finally {
        recovered.close()
      }
      const before = namespaceChecksums(path)
      let failure: unknown
      try {
        openRuntimeInstallation(path).close()
      } catch (error) {
        failure = error
      }
      expect(namespaceChecksums(path)).toEqual(before)
      expect(failure).toBeInstanceOf(Error)
      expect(String(failure)).toMatch(/rollback journal/i)
    } finally {
      const ended = stopped(child)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await ended
    }
  },
)
