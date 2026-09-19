export { compose } from "./compose.js"
export type { InspectWorkspaceOptions, WorkspaceInspection } from "./inspect-workspace.js"
export { inspectWorkspace } from "./inspect-workspace.js"
// NOTE: `localExec`/`localFilesystem` live on the `./node` subpath — importing
// them here would put node builtins back into every consumer's graph.
export type { LocalExecOptions } from "./local-exec.js"
export type { LocalFilesystemOptions } from "./local-filesystem.js"
export type {
  CapturedWorkspaceDefinition,
  CreationStatus,
  ManagedWorkspaceProvider,
  ReadyWorkspace,
  WorkspaceCreateIntent,
  WorkspaceDefinition,
  WorkspaceDeletionTarget,
  WorkspaceEnvironment,
  WorkspaceLifecycleErrorCode,
  WorkspaceProvenance,
  WorkspaceReference,
  WorkspaceSession,
  WorkspaceSessionReference,
} from "./managed-workspace.js"
export { WorkspaceLifecycleError } from "./managed-workspace.js"
export type {
  OpenWorkspaceReaderInput,
  ReadOnlyFilesystemBackend,
  SandboxConfig,
  SandboxHandle,
  SandboxPolicy,
  SandboxProvider,
  SandboxSecurityPolicy,
  SandboxWorkspaceReader,
  WorkspaceReadSource,
} from "./sandbox-types.js"
export type { SourceBundle, SourceFileInput } from "./source-bundle.js"
export type { WorkspaceSourceDefinition } from "./source-capture.js"
export type {
  BackendContext,
  ExecBackend,
  ExecMiddleware,
  FilesystemBackend,
  FilesystemMiddleware,
} from "./types.js"
export { type LoggingOptions, withExecLogging, withFilesystemLogging } from "./with-logging.js"
export { withWorkspaceReader } from "./with-workspace-reader.js"
