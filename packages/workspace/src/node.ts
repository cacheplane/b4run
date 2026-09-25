/**
 * The NODE backends. Split out of the `.` barrel so a runtime that only needs
 * the backend CONTRACTS (`FilesystemBackend`, `ExecBackend`, the middleware and
 * sandbox types — all of which stay on `.`) never drags `node:child_process`,
 * `node:fs/promises`, `node:path` or `node:util` into its module graph.
 *
 * Import these from a node entry point and inject them; `@b4run/core`'s
 * capability markers take them through `CapabilityMarkerContext`.
 */

export { type LocalExecOptions, localExec } from "./local-exec.js"
export { type LocalFilesystemOptions, localFilesystem } from "./local-filesystem.js"
export {
  captureWorkspaceDefinition,
  createWorkspaceIntent,
  stagedWorkspaceDefinition,
  verifyCapturedWorkspaceDefinition,
  verifyCreationStatus,
  verifyReadyWorkspace,
  verifyStagedWorkspaceReference,
  verifyWorkspaceIntent,
} from "./managed-workspace-node.js"
export {
  createSourceBundle,
  readSourceFile,
  type SourceBundle,
  type SourceFileInput,
  verifySourceBundle,
} from "./source-bundle.js"
export { captureWorkspaceSource, type WorkspaceSourceDefinition } from "./source-capture.js"
export {
  MAX_THREAD_SANDBOX_RECORD_BYTES,
  threadSandboxRecordBytes,
  verifyImageReference,
  verifyThreadSandbox,
  verifyThreadSandboxPermissions,
  verifyThreadSandboxPolicy,
  verifyThreadSandboxRecord,
} from "./thread-sandbox.js"
