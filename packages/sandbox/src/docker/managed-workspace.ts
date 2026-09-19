import { createHash, randomUUID } from "node:crypto"
import {
  type ManagedWorkspaceProvider,
  type ReadyWorkspace,
  type WorkspaceCreateIntent,
  WorkspaceLifecycleError,
  type WorkspaceReference,
} from "@b4run/workspace"
import {
  verifyCapturedWorkspaceDefinition,
  verifyReadyWorkspace,
  verifyWorkspaceIntent,
} from "@b4run/workspace/node"
import type { Docker, SpawnResult } from "./docker-cli.js"
import { dockerExec } from "./docker-exec.js"
import { dockerFilesystem } from "./docker-filesystem.js"
import { openDockerWorkspaceReader } from "./docker-workspace-reader.js"
import { prepareWorkspaceScript } from "./managed-workspace-prepare.js"

const PREFIX = "b4.workspace."
const VOLUME_PREFIX = "b4-ws-volume-"
/** Reader containers over a managed volume; label and hardening match the provider-storage reader. */
const READER_PREFIX = "b4-ws-reader-"
const fail = (code: "conflict" | "lost" | "unsupported" | "uncertain", message: string): never => {
  throw new WorkspaceLifecycleError(code, message)
}
function names(intent: WorkspaceCreateIntent) {
  const key = createHash("sha256")
    .update(JSON.stringify([intent.environment.binding, intent.installationId, intent.operationId]))
    .digest("hex")
  return {
    volume: `${VOLUME_PREFIX}${key}`,
    record: `b4-ws-record-${key}`,
    prepare: `b4-ws-prepare-${key}`,
    session: `b4-ws-session-${key}-`,
  }
}
function labels(intent: WorkspaceCreateIntent) {
  return {
    [`${PREFIX}intent`]: intent.digest,
    [`${PREFIX}installation`]: intent.installationId,
    [`${PREFIX}operation`]: intent.operationId,
    [`${PREFIX}source`]: intent.sourceDigest,
    [`${PREFIX}binding`]: JSON.stringify(intent.environment.binding),
  }
}
const labelArgs = (values: Record<string, string>) =>
  Object.entries(values).flatMap(([k, v]) => ["--label", `${k}=${v}`])
type Inspected = { Labels?: Record<string, string>; Config?: { Labels?: Record<string, string> } }
export function createDockerManagedWorkspaces(opts: {
  scope: string
  image: string
  docker: Docker
}): ManagedWorkspaceProvider {
  const { docker } = opts
  async function run(args: readonly string[], signal: AbortSignal): Promise<SpawnResult> {
    try {
      const result = await docker.run(args, { signal })
      if (result.exitCode !== 0)
        fail("uncertain", `Docker operation failed: ${result.stderr.trim()}`)
      return result
    } catch (error) {
      if (error instanceof WorkspaceLifecycleError) throw error
      throw new WorkspaceLifecycleError("uncertain", "Docker operation outcome unknown", {
        cause: error,
      })
    }
  }
  async function inspect(
    kind: "container" | "volume",
    name: string,
    signal: AbortSignal,
  ): Promise<Inspected | undefined> {
    let result: SpawnResult
    try {
      result = await docker.run([kind, "inspect", name], { signal })
    } catch (error) {
      throw new WorkspaceLifecycleError("uncertain", "Docker inspection failed", { cause: error })
    }
    if (result.exitCode !== 0) {
      if (
        /(?:No such (?:object|container|volume):|volume .* not found|: no such volume\s*$)/i.test(
          result.stderr,
        )
      )
        return undefined
      fail("uncertain", `Docker inspection failed: ${result.stderr}`)
    }
    try {
      const parsed = JSON.parse(result.stdout)
      if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0]) throw Error()
      return parsed[0] as Inspected
    } catch {
      return fail("uncertain", "Malformed Docker inspection")
    }
  }
  function owned(item: Inspected | undefined, intent: WorkspaceCreateIntent) {
    if (!item) return
    const actual = item.Config?.Labels ?? item.Labels
    if (!actual || Object.entries(labels(intent)).some(([key, value]) => actual[key] !== value))
      fail("conflict", "Foreign Docker workspace resource")
  }
  async function binding(intent: WorkspaceCreateIntent, signal: AbortSignal) {
    const account = (await run(["info", "--format", "{{.ID}}"], signal)).stdout.trim()
    if (
      !account ||
      intent.environment.binding.provider !== "docker" ||
      intent.environment.binding.scope !== opts.scope ||
      intent.environment.binding.account !== account
    )
      fail("conflict", "Docker workspace binding changed")
    if (!/^sha256:[0-9a-f]{64}$/.test(intent.environment.identity))
      fail("conflict", "Workspace image is not immutable")
  }
  async function remove(
    kind: "container" | "volume",
    name: string,
    intent: WorkspaceCreateIntent,
    signal: AbortSignal,
  ) {
    const item = await inspect(kind, name, signal)
    owned(item, intent)
    if (!item) return
    await run(kind === "volume" ? ["volume", "rm", name] : ["rm", "-f", name], signal)
    if (await inspect(kind, name, signal)) fail("uncertain", "Docker removal not confirmed")
  }
  async function record(
    intent: WorkspaceCreateIntent,
    signal: AbortSignal,
  ): Promise<ReadyWorkspace | undefined> {
    const n = names(intent),
      item = await inspect("container", n.record, signal)
    owned(item, intent)
    if (!item) return undefined
    try {
      const raw = item?.Config?.Labels?.[`${PREFIX}record`]
      if (!raw || Buffer.byteLength(raw) > 32768) throw Error()
      const persisted = JSON.parse(raw)
      const stored = verifyWorkspaceIntent(persisted.intent)
      if (stored.digest !== intent.digest) throw Error()
      const ready = verifyReadyWorkspace(persisted.ready, intent)
      if (
        JSON.stringify(ready.reference.resource) !==
        JSON.stringify({ record: n.record, volume: n.volume })
      )
        throw Error()
      const volume = await inspect("volume", n.volume, signal)
      owned(volume, intent)
      if (!volume) fail("lost", "Published workspace volume is missing")
      return ready
    } catch (error) {
      if (error instanceof WorkspaceLifecycleError) throw error
      return fail("conflict", "Invalid Docker ready record")
    }
  }
  async function stored(ref: WorkspaceReference, signal: AbortSignal) {
    if (!ref || !ref.resource || !/^b4-ws-record-[0-9a-f]{64}$/.test(ref.resource.record ?? ""))
      fail("conflict", "Invalid workspace coordinates")
    const item = await inspect("container", ref.resource.record ?? "", signal)
    if (!item) fail("lost", "Workspace control record is missing")
    let intent: WorkspaceCreateIntent
    try {
      const raw = item?.Config?.Labels?.[`${PREFIX}record`]
      if (!raw || Buffer.byteLength(raw) > 32768) throw Error()
      intent = verifyWorkspaceIntent(JSON.parse(raw).intent)
    } catch {
      return fail("conflict", "Invalid workspace control record")
    }
    await binding(intent, signal)
    const ready = await record(intent, signal)
    if (!ready || JSON.stringify(ready.reference) !== JSON.stringify(ref))
      fail("conflict", "Workspace reference mismatch")
    return { intent, ready: ready ?? fail("conflict", "Workspace reference mismatch") }
  }
  async function keepers(intent: WorkspaceCreateIntent, signal: AbortSignal) {
    const ids = (
      await run(
        [
          "ps",
          "-aq",
          "--filter",
          `label=${PREFIX}operation=${intent.operationId}`,
          "--filter",
          `label=${PREFIX}installation=${intent.installationId}`,
          "--filter",
          `label=${PREFIX}role=session`,
        ],
        signal,
      )
    ).stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    for (const id of ids) owned(await inspect("container", id, signal), intent)
    return ids
  }
  return {
    name: "docker",
    async resolveEnvironment(signal) {
      const account = (await run(["info", "--format", "{{.ID}}"], signal)).stdout.trim()
      const identity = (
        await run(["image", "inspect", "--format", "{{.Id}}", opts.image], signal)
      ).stdout.trim()
      if (!account || !/^sha256:[0-9a-f]{64}$/.test(identity))
        fail("unsupported", "Docker daemon/image identity unavailable")
      return { binding: { provider: "docker", scope: opts.scope, account }, identity }
    },
    async create(input, source, signal) {
      const intent = verifyWorkspaceIntent(input)
      const definition = verifyCapturedWorkspaceDefinition({
        version: 1,
        source,
        environmentLinks: intent.environmentLinks,
        ...(intent.baseline ? { baseline: intent.baseline } : {}),
      })
      if (definition.source.digest !== intent.sourceDigest)
        fail("conflict", "Workspace source digest mismatch")
      await binding(intent, signal)
      const ready = await record(intent, signal)
      if (ready) return ready
      const n = names(intent)
      const imageVolumes = (
        await run(
          ["image", "inspect", "--format", "{{json .Config.Volumes}}", intent.environment.identity],
          signal,
        )
      ).stdout.trim()
      if (imageVolumes !== "null" && imageVolumes !== "{}")
        fail("unsupported", "Managed images must not declare additional writable volumes")
      // Inspect every preexisting resource before any destructive recovery.
      owned(await inspect("container", n.prepare, signal), intent)
      owned(await inspect("volume", n.volume, signal), intent)
      await remove("container", n.prepare, intent, signal)
      await remove("volume", n.volume, intent, signal)
      await run(["volume", "create", ...labelArgs(labels(intent)), n.volume], signal)
      await run(
        [
          "run",
          "-d",
          "--name",
          n.prepare,
          ...labelArgs(labels(intent)),
          "--network",
          "none",
          "--read-only",
          "--tmpfs",
          "/tmp",
          "--tmpfs",
          "/run",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "128",
          "--user",
          "0:0",
          "--mount",
          `type=volume,src=${n.volume},dst=/workspace,volume-nocopy`,
          "--entrypoint",
          "sh",
          intent.environment.identity,
          "-c",
          "while :; do sleep 3600; done",
        ],
        signal,
      )
      let preparation: SpawnResult
      try {
        preparation = await docker.exec(
          n.prepare,
          ["env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "node", "-e", prepareWorkspaceScript],
          {
            stdin: JSON.stringify({
              files: definition.source.files,
              links: intent.environmentLinks,
              baseline: intent.baseline,
            }),
            signal,
          },
        )
      } catch (error) {
        throw new WorkspaceLifecycleError("uncertain", "Workspace preparation outcome unknown", {
          cause: error,
        })
      }
      if (preparation.exitCode !== 0)
        fail(
          "unsupported",
          `Workspace preparation requires compatible Node/Git and link targets: ${preparation.stderr}`,
        )
      let baselineCommit: unknown
      try {
        baselineCommit = JSON.parse(preparation.stdout).baselineCommit
      } catch {
        return fail("uncertain", "Invalid preparation response")
      }
      const result = verifyReadyWorkspace(
        {
          reference: {
            version: 1,
            operationId: intent.operationId,
            installationId: intent.installationId,
            threadId: intent.threadId,
            intentDigest: intent.digest,
            resource: { record: n.record, volume: n.volume },
          },
          provenance: {
            sourceDigest: intent.sourceDigest,
            environment: intent.environment,
            retention: { filesystem: "until-destroy", memory: "discarded" },
            ...(intent.baseline ? { baselineCommit } : {}),
          },
        },
        intent,
      )
      await remove("container", n.prepare, intent, signal)
      const data = JSON.stringify({ intent, ready: result })
      if (Buffer.byteLength(data) > 32768)
        fail("unsupported", "Workspace ready record exceeds Docker label limit")
      try {
        await run(
          [
            "create",
            "--name",
            n.record,
            ...labelArgs({ ...labels(intent), [`${PREFIX}record`]: data }),
            "--network",
            "none",
            "--entrypoint",
            "true",
            intent.environment.identity,
          ],
          signal,
        )
      } catch (error) {
        const recovered = await record(intent, signal)
        if (recovered) return recovered
        throw error
      }
      return (await record(intent, signal)) ?? fail("uncertain", "Publication not confirmed")
    },
    async inspectCreation(input, signal) {
      try {
        const intent = verifyWorkspaceIntent(input)
        await binding(intent, signal)
        const ready = await record(intent, signal)
        if (ready) return { status: "ready", workspace: ready }
        const n = names(intent)
        const prep = await inspect("container", n.prepare, signal),
          volume = await inspect("volume", n.volume, signal)
        owned(prep, intent)
        owned(volume, intent)
        return { status: prep || volume ? "pending" : "absent" }
      } catch (error) {
        if (error instanceof WorkspaceLifecycleError && error.code !== "uncertain")
          return {
            status: "failed",
            reason: { code: error.code, message: error.message },
            resourcesRemain: true,
          }
        return {
          status: "unknown",
          reason: error instanceof Error ? error.message : "Inspection failed",
        }
      }
    },
    async reconnect(workspace, policy, signal) {
      const { intent, ready } = await stored(workspace.reference, signal)
      verifyReadyWorkspace(workspace, intent)
      if (JSON.stringify(workspace) !== JSON.stringify(ready))
        fail("conflict", "Workspace provenance mismatch")
      const sec = policy.security ?? {},
        user = sec.runAsNonRoot
      if (typeof user === "object" && (user.uid !== 1000 || user.gid !== 1000))
        fail("unsupported", "Managed workspaces support uid/gid 1000 only")
      if (intent.environmentLinks.length && sec.readOnlyRootFilesystem === false)
        fail("unsupported", "Environment links require immutable image root")
      for (const id of await keepers(intent, signal)) await remove("container", id, intent, signal)
      const incarnation = randomUUID(),
        n = names(intent),
        container = `${n.session}${incarnation}`
      const args = [
        "run",
        "-d",
        "--name",
        container,
        ...labelArgs({
          ...labels(intent),
          [`${PREFIX}role`]: "session",
          [`${PREFIX}incarnation`]: incarnation,
        }),
        "--mount",
        `type=volume,src=${n.volume},dst=/workspace,volume-nocopy`,
        "--network",
        policy.network.mode === "deny" ? "none" : "bridge",
        "--pids-limit",
        String(sec.pidsLimit ?? 512),
        ...(sec.dropAllCapabilities === false ? [] : ["--cap-drop", "ALL"]),
        ...(sec.noNewPrivileges === false ? [] : ["--security-opt", "no-new-privileges"]),
        ...(sec.readOnlyRootFilesystem === false
          ? []
          : ["--read-only", "--tmpfs", "/tmp", "--tmpfs", "/run"]),
        ...(user === false ? [] : ["--user", "1000:1000"]),
        ...Object.entries({
          ...policy.env,
          ...(user === false ? {} : { HOME: "/workspace" }),
        }).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        ...(policy.resources?.memoryMb ? ["--memory", `${policy.resources.memoryMb}m`] : []),
        ...(policy.resources?.cpus ? ["--cpus", String(policy.resources.cpus)] : []),
        "--entrypoint",
        "sh",
        intent.environment.identity,
        "-c",
        "while :; do sleep 3600; done",
      ]
      await run(args, signal)
      // Docker CLI cancellation does not prove the remote process stopped. Retire
      // this immutable incarnation before allowing an unknown command to settle.
      let retired = false
      const sessionDocker: Docker = {
        run: docker.run.bind(docker),
        async exec(target, command, options) {
          if (retired) fail("uncertain", "Workspace session has been retired; reconnect required")
          let uncertain = true
          try {
            const result = await docker.exec(target, command, options)
            uncertain = options?.signal?.aborted === true || result.exitCode !== 0
            return result
          } finally {
            if (uncertain) {
              retired = true
              const cleanupSignal = new AbortController().signal
              await binding(intent, cleanupSignal)
              await remove("container", container, intent, cleanupSignal)
            }
          }
        },
      }
      return {
        reference: { workspace: ready.reference, incarnation },
        handle: {
          threadId: intent.threadId,
          workspaceRoot: "/workspace",
          filesystem: dockerFilesystem(sessionDocker, container),
          exec: dockerExec(
            sessionDocker,
            container,
            policy.resources?.timeoutMs === undefined
              ? {}
              : { timeoutMs: policy.resources.timeoutMs },
          ),
        },
      }
    },
    async release(session, signal) {
      if (!/^[0-9a-f-]{36}$/.test(session.incarnation))
        fail("conflict", "Invalid session incarnation")
      const { intent } = await stored(session.workspace, signal)
      const name = `${names(intent).session}${session.incarnation}`
      const item = await inspect("container", name, signal)
      owned(item, intent)
      if (item && item.Config?.Labels?.[`${PREFIX}incarnation`] !== session.incarnation)
        fail("conflict", "Session incarnation mismatch")
      await remove("container", name, intent, signal)
    },
    /**
     * Read the published workspace's volume WITHOUT touching any session.
     *
     * `stored()` is the same verification `reconnect` starts from: the record
     * container exists and is ours, the persisted intent verifies, the daemon
     * and scope binding are this provider's, the published record matches the
     * reference, and the volume exists and is ours. The caller's provenance
     * must then equal the stored record, exactly as `reconnect` requires, so a
     * reference cannot be paired with another workspace's provenance. Nothing
     * here lists or names a session container: no `ps`, no `keepers()`.
     *
     * The volume is created by `docker volume create` with the local driver, so
     * it has a host mountpoint and the reader binds that path read-only. A bind
     * refuses a missing source instead of creating a volume, which keeps the
     * "a destroyed workspace stays destroyed" property of the provider-storage
     * reader (see `openDockerWorkspaceReader`).
     */
    async openWorkspaceReader(input) {
      const { intent, ready } = await stored(input.workspace.reference, input.signal)
      try {
        verifyReadyWorkspace(input.workspace, intent)
      } catch (error) {
        throw new WorkspaceLifecycleError("conflict", "Workspace provenance mismatch", {
          cause: error,
        })
      }
      if (JSON.stringify(input.workspace) !== JSON.stringify(ready))
        fail("conflict", "Workspace provenance mismatch")
      const n = names(intent)
      return openDockerWorkspaceReader(
        {
          docker,
          // The image the workspace was prepared with, pinned by digest, not the
          // provider's mutable tag: the reader runs as the workspace's own owner.
          image: intent.environment.identity,
          volume: n.volume,
          resourceId: n.volume.slice(VOLUME_PREFIX.length),
          containerPrefix: READER_PREFIX,
        },
        {
          threadId: intent.threadId,
          signal: input.signal,
          ...(input.runAsNonRoot === undefined ? {} : { runAsNonRoot: input.runAsNonRoot }),
        },
      )
    },
    async destroy(target, signal) {
      const intent = verifyWorkspaceIntent(target.intent)
      await binding(intent, signal)
      const n = names(intent)
      if (target.reference) {
        const r = target.reference
        if (
          r.intentDigest !== intent.digest ||
          r.operationId !== intent.operationId ||
          r.installationId !== intent.installationId ||
          r.threadId !== intent.threadId ||
          r.version !== 1 ||
          JSON.stringify(r.resource) !== JSON.stringify({ record: n.record, volume: n.volume })
        )
          fail("conflict", "Deletion reference mismatch")
      }
      owned(await inspect("container", n.record, signal), intent)
      owned(await inspect("container", n.prepare, signal), intent)
      owned(await inspect("volume", n.volume, signal), intent)
      const ids = await keepers(intent, signal)
      for (const id of ids) await remove("container", id, intent, signal)
      await remove("container", n.prepare, intent, signal)
      await remove("volume", n.volume, intent, signal)
      await remove("container", n.record, intent, signal)
    },
  }
}
