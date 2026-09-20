import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { captureWorkspaceDefinition, readSourceFile } from "@b4run/workspace/node"
import { captureDirectory } from "../targets/archive.js"
import { appRoot, loadTask } from "../targets/catalog.js"
import { targetWorkspace } from "../targets/workspace.js"

export interface CapturedBaseline {
  readonly digest: string
  readonly files: ReadonlyMap<string, string>
}

/**
 * The controller's own baseline: the target's pinned subtree with the task's defect applied,
 * archived into the controller's own capture directory and captured with the framework's own
 * capture, so the digest it compares against is one it derived, never one a builder reported.
 *
 * The decoder is `fatal`, so a file that is not valid UTF-8 is a capture failure rather than
 * a silent field of replacement characters that would then diff against whatever the builder
 * actually wrote.
 *
 * Each call gets its own `instance` directory (see {@link CaptureTargetOptions}) and removes it
 * once the bytes are read into memory: the controller captures once per verification and again
 * at approve, with no serialization between them, so two concurrent captures of one task must
 * never share (and so tamper with each other's) archive directory.
 */
export async function captureTargetBaseline(
  taskId: string,
  signal: AbortSignal,
): Promise<CapturedBaseline> {
  const task = loadTask(taskId)
  const instance = randomUUID()
  const instanceDirectory = join(appRoot, captureDirectory(taskId, "controller", instance))
  try {
    const definition = targetWorkspace(task, "controller", { instance })
    const captured = await captureWorkspaceDefinition(appRoot, definition, { signal })
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const files = new Map<string, string>()
    for (const entry of captured.source.files)
      files.set(entry.path, decoder.decode(readSourceFile(captured.source, entry.path)))
    return { digest: captured.source.digest, files }
  } finally {
    rmSync(instanceDirectory, { recursive: true, force: true })
  }
}
