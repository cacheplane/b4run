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

/** Label every reader carries, so a stray one is findable and `destroy` can reap it. */
export const READER_LABEL = "b4.sandbox.reader"

export const readerLabelFor = (resourceId: string) => `${READER_LABEL}=${resourceId}`

export interface DockerWorkspaceReaderDeps {
  readonly docker: Docker
  readonly image: string
  /** Deterministic volume holding the thread's workspace. */
  readonly volume: string
  /** `resourceScope(scope)(threadId)` — used for the reader's name and label. */
  readonly resourceId: string
  /** Container name prefix; defaults to the provider-storage reader's. */
  readonly containerPrefix?: string
}

const DEFAULT_CONTAINER_PREFIX = "b4-sbx-rdr-"

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

const missingContainer = (result: { readonly stderr: string }) =>
  /no such container/i.test(result.stderr)

/**
 * Project a full backend down to reads, and refuse every read once the reader is
 * closed — otherwise a use-after-close surfaces as an opaque "no such container"
 * from Docker instead of naming the actual mistake.
 */
function readOnly(
  backend: ReturnType<typeof dockerFilesystem>,
  threadId: string,
  isClosed: () => boolean,
): ReadOnlyFilesystemBackend {
  const { lstat, readFile, readBinaryFile, listDir, statFile, walkTree, readBinaryFiles } = backend
  if (!lstat || !readBinaryFile || !statFile || !walkTree || !readBinaryFiles) {
    throw new Error("Docker filesystem backend is missing a read capability")
  }
  const live =
    <A extends unknown[], R>(operation: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      isClosed()
        ? Promise.reject(new Error(`Workspace reader for thread "${threadId}" is closed`))
        : operation(...args)
  return Object.freeze({
    lstat: live(lstat.bind(backend)),
    readFile: live(readFile.bind(backend)),
    readBinaryFile: live(readBinaryFile.bind(backend)),
    listDir: live(listDir.bind(backend)),
    statFile: live(statFile.bind(backend)),
    walkTree: live(walkTree.bind(backend)),
    readBinaryFiles: live(readBinaryFiles.bind(backend)),
  })
}

/**
 * Open a read-only view of a thread's workspace WITHOUT touching that thread's
 * keeper container. Not one Docker command below names the keeper.
 *
 * The workspace is attached as a READ-ONLY BIND of the volume's own backing
 * directory, deliberately NOT as `-v <name>:/workspace:ro`. A named-volume
 * mount CREATES a missing volume — verified: `docker run -v absent:/x:ro` exits
 * 0 and the volume then exists — so a reader racing a `destroy()` would
 * resurrect the thread's workspace as an empty volume, and the next `acquire()`
 * would reattach that empty volume instead of building a fresh one. A
 * `--mount type=bind` refuses a missing source instead of creating anything, so
 * "the workspace is gone" stays gone and stays an error.
 *
 * The container also gets `--network none` unconditionally (a reader has no
 * reason to reach the network, whatever the thread's own policy was), a
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
  const containerPrefix = deps.containerPrefix ?? DEFAULT_CONTAINER_PREFIX
  const { threadId, signal } = input
  signal.throwIfAborted()

  const inspected = await docker.run(["volume", "inspect", "--format", "{{.Mountpoint}}", volume], {
    signal,
  })
  const mountpoint = inspected.stdout.trim()
  if (inspected.exitCode !== 0 || mountpoint === "") {
    throw sandboxUnavailable(
      `Sandbox unavailable: no workspace storage for thread "${threadId}". It was never created, or it was destroyed.`,
    )
  }
  if (!mountpoint.startsWith("/") || mountpoint.includes(",")) {
    // A volume driver that reports no usable host path cannot be read this way,
    // and the alternative (a named mount) would silently recreate the volume.
    throw sandboxUnavailable(
      `Sandbox unavailable: workspace storage for thread "${threadId}" has no readable host path ("${mountpoint}"). Reading a thread workspace needs a local-driver volume.`,
    )
  }

  const user = resolveReaderUser(input.runAsNonRoot)
  const container = `${containerPrefix}${resourceId}-${randomUUID().replaceAll("-", "").slice(0, 8)}`
  // A cancelled `run -d` kills the docker CLI, not necessarily the container it
  // already asked for. Reap it on every throwing path so a failed open cannot
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
        readerLabelFor(resourceId),
        "--mount",
        `type=bind,source=${mountpoint},target=${ROOT},readonly`,
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
  try {
    const filesystem = readOnly(dockerFilesystem(docker, container), threadId, () => closed)
    return Object.freeze({
      threadId,
      workspaceRoot: ROOT,
      filesystem,
      async close() {
        if (closed) return
        // Provider-owned cleanup: no caller signal, so an aborted read can still
        // clean up. A failure is REPORTED rather than swallowed — a reader that
        // cannot be removed is a leak the caller needs to hear about — and
        // `closed` flips only on success, so a close can be retried.
        const removed = await docker.run(["rm", "-f", container])
        if (removed.exitCode !== 0 && !missingContainer(removed)) {
          throw sandboxUnavailable(
            `Sandbox unavailable: could not remove the workspace reader for thread "${threadId}": ${removed.stderr.trim() || "unknown error"}. Container "${container}" may still be running.`,
          )
        }
        closed = true
      },
    })
  } catch (error) {
    await remove()
    throw error
  }
}
