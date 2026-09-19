import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openWorkspaceInstallation } from "@b4run/sqlite-storage"
import type {
  ManagedWorkspaceProvider,
  ReadOnlyFilesystemBackend,
  ReadyWorkspace,
  SandboxProvider,
} from "@b4run/workspace"
import { createSourceBundle, createWorkspaceIntent } from "@b4run/workspace/node"

const ROOT = "/workspace"
const environment = {
  binding: { provider: "fake-managed", scope: "software-factory-builder", account: "local" },
  identity: "immutable",
}

const unused = () => {
  throw new Error("The fake managed provider only reads; the builder is not modelled here")
}

function reads(files: ReadonlyMap<string, Uint8Array>): ReadOnlyFilesystemBackend {
  const isDirectory = (path: string) => {
    const prefix = `${path}/`
    return path === ROOT || [...files.keys()].some((key) => key.startsWith(prefix))
  }
  const bytes = (path: string) => {
    const value = files.get(path)
    if (!value) throw new Error(`ENOENT: ${path}`)
    return value
  }
  return {
    async lstat(path) {
      const value = files.get(path)
      if (value) return { kind: "file", size: value.length, executable: false }
      if (isDirectory(path)) return { kind: "directory", size: 0, executable: false }
      throw new Error(`ENOENT: ${path}`)
    },
    async listDir(path) {
      const prefix = `${path}/`
      return [
        ...new Set(
          [...files.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => key.slice(prefix.length).split("/")[0] as string),
        ),
      ].sort()
    },
    async readFile(path) {
      return new TextDecoder().decode(bytes(path))
    },
    async readBinaryFile(path) {
      return bytes(path).slice()
    },
    async statFile(path) {
      return { size: bytes(path).length, mtimeMs: 0 }
    },
  }
}

/**
 * A builder app whose threads are MANAGED workspaces, without Docker: a real installation
 * store under a temporary app root (owned, as the running worker owns it) and a provider
 * whose managed half can only READ. Seeding a thread publishes a ready record in the store
 * and parks the thread's bytes in memory, keyed by the record — so a read that reaches the
 * provider with anything but the published record finds nothing, exactly as Docker would.
 */
export async function fakeManagedApp(): Promise<{
  readonly appRoot: string
  readonly provider: SandboxProvider
  seed(threadId: string, files: Record<string, string>): Promise<void>
  close(): Promise<void>
}> {
  const appRoot = await mkdtemp(join(tmpdir(), "factory-fake-managed-"))
  await mkdir(join(appRoot, ".b4", "workspaces"), { recursive: true })
  const installation = openWorkspaceInstallation(appRoot)
  const published = new Map<string, { ready: ReadyWorkspace; files: Map<string, Uint8Array> }>()
  const workspaces: ManagedWorkspaceProvider = {
    name: "fake-managed",
    async resolveEnvironment() {
      return environment
    },
    create: unused,
    inspectCreation: unused,
    reconnect: unused,
    release: unused,
    destroy: unused,
    async openWorkspaceReader({ workspace, signal }) {
      signal.throwIfAborted()
      const record = published.get(workspace.reference.operationId)
      if (!record || JSON.stringify(record.ready) !== JSON.stringify(workspace))
        throw new Error(`No managed storage for thread "${workspace.reference.threadId}"`)
      return {
        threadId: workspace.reference.threadId,
        workspaceRoot: ROOT,
        filesystem: reads(record.files),
        async close() {},
      }
    },
  }
  const provider: SandboxProvider = {
    name: "fake-managed",
    workspaces,
    acquire: unused,
    release: unused,
    destroy: unused,
  }
  return {
    appRoot,
    provider,
    async seed(threadId, files) {
      const source = createSourceBundle([
        { path: "TASK.md", bytes: Buffer.from("seeded\n"), executable: false },
      ])
      installation.sources.put(source)
      const intent = createWorkspaceIntent({
        installationId: installation.installationId,
        operationId: randomUUID(),
        threadId,
        definition: { version: 1, source, environmentLinks: [] },
        environment,
      })
      const created = installation.associations.create(intent)
      const ready: ReadyWorkspace = {
        reference: {
          version: 1,
          operationId: intent.operationId,
          installationId: intent.installationId,
          threadId,
          intentDigest: intent.digest,
          resource: { record: `fake-${intent.operationId}` },
        },
        provenance: {
          sourceDigest: intent.sourceDigest,
          environment,
          retention: { filesystem: "until-destroy", memory: "discarded" },
        },
      }
      const stored = installation.associations.markReady(threadId, created.revision, ready)
      published.set(intent.operationId, {
        ready: stored.ready as ReadyWorkspace,
        files: new Map(
          Object.entries(files).map(([path, text]) => [
            `${ROOT}/${path}`,
            new TextEncoder().encode(text),
          ]),
        ),
      })
    },
    async close() {
      installation.close()
      await rm(appRoot, { recursive: true, force: true })
    },
  }
}
