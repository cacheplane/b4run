import { randomUUID } from "node:crypto"
import type {
  ManagedWorkspaceProvider,
  ReadyWorkspace,
  SandboxProvider,
  WorkspaceCreateIntent,
} from "@b4run/workspace"
import { verifyReadyWorkspace } from "@b4run/workspace/node"
/** A remote-service model: records and files survive compute sessions and runtime objects. */
export function managedProviderFixture() {
  const records = new Map<
    string,
    { intent: WorkspaceCreateIntent; ready: ReadyWorkspace; files: Map<string, Uint8Array> }
  >()
  const sessions = new Set<string>()
  const calls: string[] = []
  const workspaces: ManagedWorkspaceProvider = {
    name: "test-service",
    async resolveEnvironment() {
      return {
        binding: { provider: "test-service", scope: "example", account: "account" },
        identity: "immutable-template",
      }
    },
    async inspectCreation(intent) {
      calls.push("inspect")
      const record = records.get(intent.operationId)
      return record
        ? { status: "ready", workspace: verifyReadyWorkspace(record.ready, intent) }
        : { status: "absent" }
    },
    async create(intent, source) {
      calls.push("create")
      const ready: ReadyWorkspace = {
        reference: {
          version: 1,
          installationId: intent.installationId,
          operationId: intent.operationId,
          threadId: intent.threadId,
          intentDigest: intent.digest,
          resource: { remoteId: randomUUID() },
        },
        provenance: {
          sourceDigest: source.digest,
          environment: intent.environment,
          retention: { filesystem: "until-destroy", memory: "retained" },
        },
      }
      records.set(intent.operationId, {
        intent,
        ready,
        files: new Map(
          source.files.map((file) => [
            `/workspace/${file.path}`,
            new Uint8Array(Buffer.from(file.base64, "base64")),
          ]),
        ),
      })
      return ready
    },
    async reconnect(ready) {
      calls.push("reconnect")
      const record = records.get(ready.reference.operationId)
      if (!record) throw new Error("Remote workspace lost")
      const incarnation = randomUUID()
      sessions.add(incarnation)
      const live = () => {
        if (!sessions.has(incarnation)) throw new Error("Session retired")
      }
      const read = async (path: string) => {
        live()
        const bytes = record.files.get(path)
        if (!bytes) throw new Error("ENOENT")
        return bytes.slice()
      }
      return {
        reference: { workspace: ready.reference, incarnation },
        handle: {
          threadId: ready.reference.threadId,
          workspaceRoot: "/workspace",
          filesystem: {
            readBinaryFile: read,
            async readFile(path) {
              return new TextDecoder().decode(await read(path))
            },
            async writeFile(path, text) {
              live()
              const bytes = new TextEncoder().encode(text)
              record.files.set(path, bytes)
              return { bytesWritten: bytes.length }
            },
            async realPath(path) {
              live()
              return path
            },
            async listDir(path) {
              live()
              const prefix = path.endsWith("/") ? path : `${path}/`
              return [
                ...new Set(
                  [...record.files.keys()]
                    .filter((key) => key.startsWith(prefix))
                    .map((key) => key.slice(prefix.length).split("/")[0] as string),
                ),
              ]
            },
          },
          exec: {
            async runCommand() {
              live()
              return { stdout: "", stderr: "", exitCode: 0 }
            },
          },
        },
      }
    },
    async release(session) {
      calls.push("release")
      sessions.delete(session.incarnation)
    },
    async destroy(target) {
      calls.push("destroy")
      records.delete(target.intent.operationId)
    },
  }
  const provider: SandboxProvider = {
    name: "test-service",
    workspaces,
    async acquire() {
      throw new Error("Legacy acquire must never be used")
    },
    async release() {
      throw new Error("Legacy release must never be used")
    },
    async destroy() {
      throw new Error("Legacy destroy must never be used")
    },
  }
  return { provider, workspaces, records, calls }
}
