export interface SourceFile {
  path: string
  content: string
  executable: boolean
}
export interface SourceManifest {
  digest: string
  files: readonly SourceFile[]
  dependencyTarget: string
}
export interface Attempt {
  installationId: string
  logicalId: string
  generationId: string
  imageId: string
  volumeName: string
  preparerName: string
  sessionName: string
  preparerId?: string
  sessionId?: string
}
export type WorkspaceStatus = "preparing" | "ready" | "deleting" | "deleted"
export interface WorkspaceRecord {
  logicalId: string
  source: SourceManifest
  imageId: string
  status: WorkspaceStatus
  attempt: Attempt
}
export interface ResourceInspection {
  volume: boolean
  preparer?: { id: string; running: boolean }
  session?: { id: string; running: boolean }
}
export interface RecoveryResources {
  hasResources(installationId: string, logicalId: string): Promise<boolean>
  prepare(attempt: Attempt, source: SourceManifest, imageId: string): Promise<void>
  inspect(attempt: Attempt): Promise<ResourceInspection>
  stop(attempt: Attempt): Promise<void>
  attach(attempt: Attempt, imageId: string): Promise<string>
  release(attempt: Attempt): Promise<void>
  destroy(attempt: Attempt): Promise<void>
}
export type FaultPoint =
  | "intent"
  | "created"
  | "copying"
  | "validated"
  | "stopped"
  | "published"
  | "deleting"
export type FaultHook = (point: FaultPoint, attempt: Attempt) => void | Promise<void>
