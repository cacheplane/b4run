export { compose } from "./compose.js"
export type { InspectWorkspaceOptions, WorkspaceInspection } from "./inspect-workspace.js"
export { inspectWorkspace } from "./inspect-workspace.js"
export {
  isCanonicalWorkspaceRoot,
  isWorkspaceInspectionError,
  isWorkspaceReadLimitError,
  WorkspaceInspectionError,
  type WorkspaceInspectionErrorCode,
  type WorkspaceInspectionErrorDetail,
  WorkspaceReadLimitError,
} from "./inspection-errors.js"
// NOTE: `localExec`/`localFilesystem` live on the `./node` subpath — importing
// them here would put node builtins back into every consumer's graph.
export type { LocalExecOptions } from "./local-exec.js"
export type { LocalFilesystemOptions } from "./local-filesystem.js"
export type {
  CapturedWorkspaceDefinition,
  CreationStatus,
  ManagedWorkspaceProvider,
  OpenManagedWorkspaceReaderInput,
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
  ThreadSandbox,
  ThreadSandboxPermissions,
  ThreadSandboxPolicy,
  ThreadSandboxRecord,
  ThreadSandboxResolver,
  WorkspaceReadSource,
  WorkspaceResolver,
  WorkspaceResolverInput,
} from "./sandbox-types.js"
export type { SourceBundle, SourceFileInput } from "./source-bundle.js"
export type { WorkspaceSourceDefinition } from "./source-capture.js"
export type {
  BackendContext,
  ExecBackend,
  ExecMiddleware,
  FilesystemBackend,
  FilesystemMiddleware,
  WalkedEntry,
} from "./types.js"
export { type LoggingOptions, withExecLogging, withFilesystemLogging } from "./with-logging.js"
export { scopedWorkspaceReader, withWorkspaceReader } from "./with-workspace-reader.js"
