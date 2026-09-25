/**
 * Host-side managed-workspace lifecycle, without the `b4` command program.
 *
 * The package root (src/index.ts) is the CLI itself — shebang, commander, every
 * command module — so a separate host process that only wants to own workspace
 * lifecycle had no way to get `withWorkspace` without importing all of that.
 * Exposed as the `@b4run/cli/workspace` subpath.
 *
 * Pair `withWorkspace` with `@b4run/workspace`'s `withWorkspaceReader` to
 * capture a baseline here and read a worker thread's produced bytes there —
 * or, when the worker's threads are MANAGED workspaces (the app declares
 * `sandbox.workspace` or `sandbox.thread`), with `withManagedWorkspaceReader`, which resolves the
 * thread through the worker's installation store. `readThreadWorkspace` reads
 * the same inventory over the worker's Agent Protocol port
 * (`sandbox.workspaceRead`), for a caller with no path to the worker's app root.
 */

export { cleanupWorkspaces } from "./lib/runtime/cleanup-workspaces.js"
export {
  type ManagedWorkspaceReadOptions,
  openManagedWorkspaceReader,
  withManagedWorkspaceReader,
} from "./lib/runtime/managed-workspace-reader.js"
export {
  type ReadThreadWorkspaceInit,
  type ReadThreadWorkspaceOptions,
  readThreadWorkspace,
  type ThreadWorkspaceRead,
  ThreadWorkspaceReadError,
} from "./lib/runtime/read-thread-workspace.js"
export { type WithWorkspaceOptions, withWorkspace } from "./lib/runtime/with-workspace.js"
