import { randomUUID } from "node:crypto"
import type {
  OpenWorkspaceReaderInput,
  ReadOnlyFilesystemBackend,
  SandboxWorkspaceReader,
} from "@b4run/workspace"
import { sandboxUnavailable } from "../errors.js"
import type { Docker } from "./docker-cli.js"
import { dockerFilesystem } from "./docker-filesystem.js"

const ROOT = "/workspace"
/** A reader runs `stat`, `find`, `readlink` and `base64`. It never needs many processes. */
const READER_PIDS_LIMIT = 128

export interface DockerWorkspaceReaderDeps {
  readonly docker: Docker
  readonly image: string
  /** Deterministic volume holding the thread's workspace. Mounted read-only. */
  readonly volume: string
  /** `resourceScope(scope)(threadId)` — used for the reader's name and label. */
  readonly resourceId: string
}

/** Same defaulting rule as the keeper's launch config, so a reader matches its workspace's owner. */
function resolveReaderUser(
  runAsNonRoot: OpenWorkspaceReaderInput["runAsNonRoot"],
): { readonly uid: number; readonly gid: number } | null {
  if (runAsNonRoot === false) return null
  if (typeof runAsNonRoot === "object" && runAsNonRoot !== null) {
    return { uid: runAsNonRoot.uid, gid: runAsNonRoot.gid }
  }
  return { uid: 1000, gid: 1000 }
}

/** Project a full backend down to reads. The returned object has no write member to call. */
function readOnly(backend: ReturnType<typeof dockerFilesystem>): ReadOnlyFilesystemBackend {
  const { lstat, readFile, readBinaryFile, listDir, statFile } = backend
  if (!lstat || !readBinaryFile || !statFile) {
    throw new Error("Docker filesystem backend is missing a read capability")
  }
  return Object.freeze({
    lstat: lstat.bind(backend),
    readFile: readFile.bind(backend),
    readBinaryFile: readBinaryFile.bind(backend),
    listDir: listDir.bind(backend),
    statFile: statFile.bind(backend),
  })
}

/**
 * Open a read-only view of a thread's workspace volume WITHOUT touching that
 * thread's keeper container. Not one Docker command below names the keeper.
 *
 * The view is a separate, ephemeral container with the volume bind-mounted
 * `:ro`, so a write fails with EROFS from the kernel rather than from a policy
 * check. The container also gets `--network none` unconditionally (a reader has
 * no reason to reach the network, whatever the thread's own policy was), a
 * read-only root filesystem, no capabilities, no privilege escalation, and a
 * small pids limit.
 *
 * Reads deliberately carry NO exec lease and NO PID-exhaustion recovery: that
 * recovery path works by replacing a container, which is the precise behaviour
 * this surface exists to avoid. A PID-exhausted reader errors; it recreates
 * nothing.
 */
export async function openDockerWorkspaceReader(
  deps: DockerWorkspaceReaderDeps,
  input: OpenWorkspaceReaderInput,
): Promise<SandboxWorkspaceReader> {
  const { docker, image, volume, resourceId } = deps
  const { threadId, signal } = input
  signal.throwIfAborted()

  const volumeExists = await docker.run(["volume", "inspect", volume], { signal })
  if (volumeExists.exitCode !== 0) {
    throw sandboxUnavailable(
      `Sandbox unavailable: no workspace storage for thread "${threadId}". It was never created, or it was destroyed.`,
    )
  }

  const user = resolveReaderUser(input.runAsNonRoot)
  const container = `b4-sbx-rdr-${resourceId}-${randomUUID().replaceAll("-", "").slice(0, 8)}`
  // A cancelled `run -d` kills the docker CLI, not necessarily the container it
  // already asked for. Reap it on the throwing path so an abort mid-open cannot
  // strand a reader the caller never received a `close()` for.
  const remove = () => docker.run(["rm", "-f", container]).catch(() => {})
  const created = await docker
    .run(
      [
        "run",
        "-d",
        "--rm",
        "--name",
        container,
        "--label",
        `b4.sandbox.reader=${resourceId}`,
        "-v",
        `${volume}:${ROOT}:ro`,
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        String(READER_PIDS_LIMIT),
        "--read-only",
        "--tmpfs",
        "/tmp",
        "--tmpfs",
        "/run",
        ...(user !== null ? ["--user", `${user.uid}:${user.gid}`] : []),
        image,
        "sleep",
        "infinity",
      ],
      { signal },
    )
    .catch(async (error: unknown) => {
      await remove()
      throw error
    })
  if (created.exitCode !== 0) {
    await remove()
    throw sandboxUnavailable(
      `Sandbox unavailable: could not open a workspace reader for thread "${threadId}": ${created.stderr.trim() || "unknown error"}. Run \`b4 check\`.`,
    )
  }

  let closed = false
  return Object.freeze({
    threadId,
    workspaceRoot: ROOT,
    filesystem: readOnly(dockerFilesystem(docker, container)),
    async close() {
      if (closed) return
      closed = true
      // Provider-owned cleanup: no caller signal, and a gone container is fine.
      await docker.run(["rm", "-f", container]).catch(() => {})
    },
  })
}
