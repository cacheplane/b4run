import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openWorkspaceInstallation } from "@b4run/sqlite-storage"
import { inspectWorkspace, type SandboxProvider } from "@b4run/workspace"
import { createSourceBundle } from "@b4run/workspace/node"
import { afterEach, describe, expect, it } from "vitest"
import { ManagedWorkspaceManager } from "../src/lib/runtime/managed-workspace-manager.ts"
import {
  openManagedWorkspaceReader,
  withManagedWorkspaceReader,
} from "../src/lib/runtime/managed-workspace-reader.ts"
import { managedProviderFixture } from "./support/managed-provider.ts"

const signal = new AbortController().signal
const source = createSourceBundle([
  { path: "src/index.ts", bytes: Buffer.from("export {}\n"), executable: false },
])
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A worker: it OWNS the installation, exactly as a running `b4` server does. */
async function worker(options: { readonly reads?: boolean } = {}) {
  const appRoot = mkdtempSync(join(tmpdir(), "b4-managed-reader-"))
  mkdirSync(join(appRoot, ".b4", "workspaces"), { recursive: true })
  cleanups.push(() => rmSync(appRoot, { recursive: true, force: true }))
  const fixture = managedProviderFixture(options)
  const installation = openWorkspaceInstallation(appRoot)
  const manager = new ManagedWorkspaceManager({
    installation,
    definition: { version: 1, source, environmentLinks: [] },
    provider: fixture.workspaces,
    policy: { network: { mode: "deny" } },
    idleTimeoutMs: 60_000,
  })
  cleanups.push(() => manager.releaseAll())
  return { appRoot, fixture, manager, installation }
}

describe("openManagedWorkspaceReader", () => {
  it("reads a thread's published workspace while the worker owns the installation", async () => {
    const w = await worker()
    const handle = await w.manager.getForThread("t-1", signal)
    await handle.filesystem.writeFile("/workspace/out.txt", "produced", {
      signal,
      workspaceRoot: "/workspace",
    })
    const inspection = await withManagedWorkspaceReader(
      { appRoot: w.appRoot, provider: w.fixture.provider, threadId: "t-1", signal },
      (reader) => {
        expect(reader.threadId).toBe("t-1")
        return inspectWorkspace(reader, { signal })
      },
    )
    expect(inspection.files).toEqual({ "src/index.ts": "export {}\n", "out.txt": "produced" })
    // Opened by record, closed by the helper, and the session was never touched.
    expect(w.fixture.calls.filter((c) => c === "read" || c === "close")).toEqual(["read", "close"])
    expect(w.fixture.calls.filter((c) => c === "reconnect")).toHaveLength(1)
  })

  it("passes the reader identity through", async () => {
    const w = await worker()
    await w.manager.getForThread("t-1", signal)
    const reads: unknown[] = []
    const provider: SandboxProvider = {
      ...w.fixture.provider,
      workspaces: {
        ...w.fixture.workspaces,
        async openWorkspaceReader(input) {
          reads.push(input.runAsNonRoot)
          return w.fixture.workspaces.openWorkspaceReader?.(input) as never
        },
      },
    }
    const reader = await openManagedWorkspaceReader({
      appRoot: w.appRoot,
      provider,
      threadId: "t-1",
      signal,
      runAsNonRoot: false,
    })
    await reader.close()
    expect(reads).toEqual([false])
  })

  it("refuses a thread the worker has never seen, without inventing storage", async () => {
    const w = await worker()
    await w.manager.getForThread("t-1", signal)
    await expect(
      openManagedWorkspaceReader({
        appRoot: w.appRoot,
        provider: w.fixture.provider,
        threadId: "t-2",
        signal,
      }),
    ).rejects.toMatchObject({
      code: "lost",
      message: expect.stringMatching(/No managed workspace/),
    })
    expect(w.fixture.calls).not.toContain("read")
  })

  it("refuses a deleted thread", async () => {
    const w = await worker()
    await w.manager.getForThread("t-1", signal)
    await w.manager.destroyThread("t-1")
    await expect(
      openManagedWorkspaceReader({
        appRoot: w.appRoot,
        provider: w.fixture.provider,
        threadId: "t-1",
        signal,
      }),
    ).rejects.toMatchObject({ code: "lost", message: expect.stringMatching(/deleted/) })
  })

  it("refuses a workspace that is not published yet", async () => {
    const w = await worker()
    const environment = await w.fixture.workspaces.resolveEnvironment(signal)
    const { createWorkspaceIntent } = await import("@b4run/workspace/node")
    w.installation.sources.put(source)
    w.installation.associations.create(
      createWorkspaceIntent({
        installationId: w.installation.installationId,
        operationId: "00000000-0000-4000-8000-000000000009",
        threadId: "t-pending",
        definition: { version: 1, source, environmentLinks: [] },
        environment,
      }),
    )
    await expect(
      openManagedWorkspaceReader({
        appRoot: w.appRoot,
        provider: w.fixture.provider,
        threadId: "t-pending",
        signal,
      }),
    ).rejects.toMatchObject({ code: "retryable" })
  })

  it("refuses when there is no installation under the app root", async () => {
    const w = await worker()
    const empty = mkdtempSync(join(tmpdir(), "b4-managed-reader-empty-"))
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }))
    await expect(
      openManagedWorkspaceReader({
        appRoot: empty,
        provider: w.fixture.provider,
        threadId: "t-1",
        signal,
      }),
    ).rejects.toThrow(/No workspace installation/)
  })

  it("names the missing capability before touching the store", async () => {
    const w = await worker({ reads: false })
    await w.manager.getForThread("t-1", signal)
    await expect(
      openManagedWorkspaceReader({
        appRoot: w.appRoot,
        provider: w.fixture.provider,
        threadId: "t-1",
        signal,
      }),
    ).rejects.toThrow(/"test-service" does not support reading a workspace/)
    const { workspaces: _omitted, ...bare } = w.fixture.provider
    await expect(
      openManagedWorkspaceReader({ appRoot: w.appRoot, provider: bare, threadId: "t-1", signal }),
    ).rejects.toThrow(/does not support managed workspaces/)
  })

  it("aggregates a body failure with a close failure", async () => {
    const w = await worker()
    await w.manager.getForThread("t-1", signal)
    const closeError = new Error("close failed")
    const provider: SandboxProvider = {
      ...w.fixture.provider,
      workspaces: {
        ...w.fixture.workspaces,
        async openWorkspaceReader(input) {
          const reader = await (w.fixture.workspaces.openWorkspaceReader?.(
            input,
          ) as never as Promise<
            Awaited<ReturnType<NonNullable<typeof w.fixture.workspaces.openWorkspaceReader>>>
          >)
          return {
            ...reader,
            async close() {
              throw closeError
            },
          }
        },
      },
    }
    const bodyError = new Error("body failed")
    const thrown = await withManagedWorkspaceReader(
      { appRoot: w.appRoot, provider, threadId: "t-1", signal },
      async () => {
        throw bodyError
      },
    ).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([bodyError, closeError])
  })
})
