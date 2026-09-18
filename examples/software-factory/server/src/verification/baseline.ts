import { captureWorkspaceDefinition, readSourceFile } from "@b4run/workspace/node"
import { appRoot } from "../fixtures/catalog.js"
import { fixtureWorkspace } from "../fixtures/workspace.js"

export interface CapturedBaseline {
  readonly digest: string
  readonly files: ReadonlyMap<string, string>
}

/**
 * The controller's own baseline. It captures the fixture with the framework's own
 * capture, so the digest it compares against is one it derived, never one a
 * builder reported.
 *
 * The decoder is `fatal`, so a fixture file that is not valid UTF-8 is a capture
 * failure rather than a silent field of replacement characters that would then
 * diff against whatever the builder actually wrote.
 */
export async function captureFixtureBaseline(
  taskId: string,
  signal: AbortSignal,
): Promise<CapturedBaseline> {
  const captured = await captureWorkspaceDefinition(appRoot, fixtureWorkspace(taskId), { signal })
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const files = new Map<string, string>()
  for (const entry of captured.source.files)
    files.set(entry.path, decoder.decode(readSourceFile(captured.source, entry.path)))
  return { digest: captured.source.digest, files }
}
