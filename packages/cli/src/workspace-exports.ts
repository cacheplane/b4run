/**
 * Host-side managed-workspace lifecycle, without the `b4` command program.
 *
 * The package root (src/index.ts) is the CLI itself — shebang, commander, every
 * command module — so a separate host process that only wants to own workspace
 * lifecycle had no way to get `withWorkspace` without importing all of that.
 * Exposed as the `@b4run/cli/workspace` subpath.
 *
 * Pair it with `@b4run/workspace`'s `withWorkspaceReader` to capture a baseline
 * here and read a worker thread's produced bytes there.
 */

export { cleanupWorkspaces } from "./lib/runtime/cleanup-workspaces.js"
export { type WithWorkspaceOptions, withWorkspace } from "./lib/runtime/with-workspace.js"
