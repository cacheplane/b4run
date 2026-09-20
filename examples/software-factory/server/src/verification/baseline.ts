import { captureWorkspaceDefinition, readSourceFile } from "@b4run/workspace/node"
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
 */
export async function captureTargetBaseline(
  taskId: string,
  signal: AbortSignal,
): Promise<CapturedBaseline> {
  const task = loadTask(taskId)
  const captured = await captureWorkspaceDefinition(appRoot, targetWorkspace(task, "controller"), {
    signal,
  })
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const files = new Map<string, string>()
  for (const entry of captured.source.files)
    files.set(entry.path, decoder.decode(readSourceFile(captured.source, entry.path)))
  return { digest: captured.source.digest, files }
}

/** Bridge until src/fixtures is retired. */
export const captureFixtureBaseline = captureTargetBaseline
