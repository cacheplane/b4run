import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { captureWorkspaceDefinition, verifySourceBundle } from "@b4run/workspace/node"
import { captureDirectory } from "../targets/archive.js"
import { loadTaskRecipe } from "../targets/catalog.js"
import { targetWorkspace } from "../targets/workspace.js"

export interface CapturedBaseline {
  readonly digest: string
  readonly files: ReadonlyMap<string, string>
}

/**
 * The controller's own baseline: the target's pinned subtree with the task's defect applied,
 * archived into the controller's own capture directory under `options.captureRoot` (its
 * `FACTORY_STATE_DIR`, never its app root: see `CaptureTargetOptions`) and captured with the framework's own
 * capture, so the digest it compares against is one it derived, never one a builder reported.
 *
 * The decoder is `fatal`, so a file that is not valid UTF-8 is a capture failure rather than
 * a silent field of replacement characters that would then diff against whatever the builder
 * actually wrote.
 *
 * The bundle is verified ONCE (~40-60 ms for a target-sized capture) and each file decoded from
 * that verified copy (~3 ms for all of them). `readSourceFile` re-verifies the whole bundle on
 * every call, so reading a ~343-file target through it was one synchronous block of 15-20 s
 * that stopped the controller, and its /healthz, answering for the length of every capture.
 *
 * Each call gets its own `instance` directory (see {@link CaptureTargetOptions}) and removes it
 * once the bytes are read into memory: the controller captures once per verification and again
 * at approve, with no serialization between them, so two concurrent captures of one task must
 * never share (and so tamper with each other's) archive directory.
 */
export async function captureTargetBaseline(
  taskId: string,
  signal: AbortSignal,
  options: { readonly captureRoot: string },
): Promise<CapturedBaseline> {
  const { captureRoot } = options
  const task = loadTaskRecipe(taskId)
  const instance = randomUUID()
  const instanceDirectory = join(captureRoot, captureDirectory(taskId, "controller", instance))
  try {
    const definition = targetWorkspace(task, "controller", { instance, captureRoot })
    const captured = await captureWorkspaceDefinition(captureRoot, definition, { signal })
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const source = verifySourceBundle(captured.source)
    const files = new Map<string, string>()
    for (const entry of source.files)
      files.set(entry.path, decoder.decode(Buffer.from(entry.base64, "base64")))
    return { digest: source.digest, files }
  } finally {
    rmSync(instanceDirectory, { recursive: true, force: true })
  }
}
