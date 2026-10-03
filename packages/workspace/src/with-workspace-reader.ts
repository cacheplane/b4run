import type {
  OpenWorkspaceReaderInput,
  SandboxProvider,
  SandboxWorkspaceReader,
} from "./sandbox-types.js"

/**
 * Open a thread's read-only workspace view, hand it to `operation`, and close it
 * whatever happens. A close failure is never allowed to swallow a body failure:
 * both surface, aggregated.
 *
 * Throws when the provider has no `openWorkspaceReader` capability — the check
 * is here so every caller gets the same message instead of inventing one.
 */
export async function withWorkspaceReader<T>(
  provider: SandboxProvider,
  input: OpenWorkspaceReaderInput,
  operation: (reader: SandboxWorkspaceReader) => Promise<T>,
): Promise<T> {
  const open = provider.openWorkspaceReader
  if (typeof open !== "function") {
    throw new Error(
      `Sandbox provider "${provider.name}" does not support reading a thread workspace`,
    )
  }
  return scopedWorkspaceReader(() => open.call(provider, input), operation)
}

/**
 * The lifetime rule behind `withWorkspaceReader`, for any way of opening a
 * reader (provider storage by thread id, managed storage by published record):
 * open, run, always close, and never let a close failure hide a body failure.
 */
export async function scopedWorkspaceReader<T>(
  open: () => Promise<SandboxWorkspaceReader>,
  operation: (reader: SandboxWorkspaceReader) => Promise<T>,
): Promise<T> {
  const reader = await open()
  let failed = false
  let failure: unknown
  let result: T | undefined
  try {
    result = await operation(reader)
  } catch (error) {
    failed = true
    failure = error
  }
  try {
    await reader.close()
  } catch (error) {
    failure = failed
      ? new AggregateError([failure, error], "Workspace read and reader close failed")
      : error
    failed = true
  }
  if (failed) throw failure
  return result as T
}
