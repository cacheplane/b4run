import type { B4DiagnosticV1 } from "./errors.js"
import type {
  Agent,
  AspCommand,
  AspEvent,
  AspEventStreamRequest,
  AspInputInjectParams,
  AspInputRequestedData,
  AspInputRespondParams,
  AspResponseMeta,
  AspRunStartParams,
  Item,
  NativeAgentCapabilities,
  Run,
  RunCreate,
  RunStatus,
  Thread,
  ThreadCreate,
  ThreadPatch,
  ThreadState,
} from "./types.js"

export const AGENT_PROTOCOL_VERSIONS = { openapi: "0.1.6", cddl: "0.0.20", b4: 1 } as const
export const B4_METADATA_KEY = "b4"
export const B4_CUSTOM_EVENT_NAMES = [
  "b4.run",
  "b4.turn",
  "b4.input",
  "b4.activity",
  "b4.history",
] as const
/** Canonical lowercase UUID at the wire boundary; validate with CanonicalId schema. */
export type CanonicalId = string
export type NativeSubmissionToken = string
export type Namespace = readonly string[]
export type RunReason =
  | "completed"
  | "permission"
  | "user_stop"
  | "server_shutdown"
  | "deadline"
  | "execution_error"
  | "execution_lost"
  | "client_disconnect"
export type RunPhase = "accepted" | "running" | "settled"
export type Continuation = "none" | "waiting" | "closed"
export type SubmissionKind = "b4" | "agui"
export type ReceiptDisposition = "accepted" | "applied" | "not_applied"
export interface RequestMetadataV1 {
  readonly v: 1
  readonly submissionId?: CanonicalId
  readonly expected?: {
    readonly generation?: CanonicalId
    readonly runId?: CanonicalId
    readonly pausedGeneration?: CanonicalId
  }
}
type CallerAnnotations = Readonly<Record<string, unknown>> & {
  readonly "b4.submissionId"?: never
  readonly "b4.submissionKind"?: never
  readonly "b4.operationThreadId"?: never
  readonly "b4.targetRunId"?: never
}
export type CallerThreadMetadata = CallerAnnotations & { readonly b4?: never }
export type CallerRunMetadata = CallerAnnotations & { readonly b4?: RequestMetadataV1 }
export interface OperationLookupSelectors {
  readonly "b4.submissionId": string
  readonly "b4.submissionKind": SubmissionKind
  readonly "b4.operationThreadId"?: CanonicalId
  readonly "b4.targetRunId"?: CanonicalId
  readonly [key: string]: unknown
}
export interface ReceiptV1 {
  readonly submissionId: string
  readonly submissionKind: SubmissionKind
  readonly runId: CanonicalId
  readonly turnId: CanonicalId
  readonly acceptedAt: string
  readonly replayed: boolean
  readonly disposition: ReceiptDisposition
  readonly inputId?: CanonicalId
  readonly reason?: string
}
export type OperationLookupV1 = {
  readonly submissionId: string
  readonly submissionKind: SubmissionKind
} & (
  | { readonly state: "accepted"; readonly receipt: ReceiptV1 }
  | { readonly state: "expired"; readonly receipt?: never }
)
export interface ReceiptResponseMetaV1 {
  readonly v: 1
  readonly receipt: ReceiptV1
  readonly [key: string]: unknown
}
export interface InputReceiptResultV1 {
  readonly runId: CanonicalId
  readonly b4: ReceiptResponseMetaV1
  readonly [key: string]: unknown
}
export interface RunMetadataV1 {
  readonly v: 1
  readonly generation: CanonicalId
  readonly turnId: CanonicalId
  readonly previousRunId?: CanonicalId
  readonly phase: RunPhase
  readonly reason?: RunReason
  readonly continuation: Continuation
  readonly submissionId?: string
  readonly acceptedAt: string
  readonly startedAt?: string
  readonly settledAt?: string
  readonly effectsUncertain: boolean
  readonly submissionKind?: SubmissionKind
  readonly webhook?: WebhookDeliverySummary
  readonly lookup?: OperationLookupV1
  readonly [key: string]: unknown
}
export interface RunSummary {
  readonly runId: CanonicalId
  readonly turnId: CanonicalId
  readonly agentId: string
  readonly status: RunStatus
  readonly phase: RunPhase
  readonly continuation: Continuation
  readonly effectsUncertain: boolean
  readonly previousRunId?: CanonicalId
  readonly reason?: RunReason
  readonly [key: string]: unknown
}
export interface TurnSummary {
  readonly turnId: CanonicalId
  readonly currentRunId: CanonicalId
  readonly state: "running" | "waiting" | "completed" | "stopped" | "error" | "timeout"
  readonly continuation: Continuation
  readonly reason?: RunReason
  readonly [key: string]: unknown
}
export interface PermissionResponseV1 {
  readonly decision: "once" | "always" | "deny"
  readonly grant?: string
}
export interface PermissionPayloadV1 {
  readonly type: "b4.permission"
  readonly v: 1
  readonly request: Readonly<Record<string, unknown>>
  readonly responseSchema: Readonly<Record<string, unknown>>
  readonly allowedDecisions: readonly PermissionResponseV1["decision"][]
  readonly allowAlways: boolean
  readonly [key: string]: unknown
}
export interface PendingMetadataV1 {
  readonly v: 1
  readonly pausedGeneration: CanonicalId
  readonly proposalHash: string
  readonly status: "waiting" | "expired" | "resolved" | "denied" | "abandoned" | "stopped"
  readonly expiresAt?: string
  readonly grant?: string
  readonly responseSchema?: Readonly<Record<string, unknown>>
  readonly [key: string]: unknown
}
export interface PendingInput {
  readonly namespace: Namespace
  readonly runId: CanonicalId
  readonly turnId: CanonicalId
  readonly data: AspInputRequestedData & { readonly b4: PendingMetadataV1 }
  readonly [key: string]: unknown
}
export interface RecoveryCheckpoint {
  readonly checkpoint_id: CanonicalId
  readonly namespace: Namespace
  readonly parent_checkpoint_id?: CanonicalId
  readonly [key: string]: unknown
}
export interface HistoryLineage {
  readonly checkpointId: CanonicalId
  readonly namespace: Namespace
  readonly fragmentIndex: number
  readonly parentCheckpointId?: CanonicalId
  readonly sourceThreadId?: CanonicalId
  readonly sourceCheckpointId?: CanonicalId
  readonly originRunId?: CanonicalId
  readonly [key: string]: unknown
}
export interface HistoryCoverage {
  /** Nonempty opaque frozen-selection identity; equality only, never a request member or authority. */
  readonly anchor: string
  readonly nextBefore: string | null
  readonly complete: boolean
  readonly [key: string]: unknown
}
export type ActivityType =
  | "message"
  | "tool"
  | "plan"
  | "reasoning"
  | "subagent"
  | "provider"
  | "answer"
  | "input"
  | "outcome"
  | (string & {})
export type ActivityState =
  | "open"
  | "completed"
  | "interrupted"
  | "failed"
  | "denied"
  | "cancelled"
  | "historical"
/** Opaque payload preserves existing versioned Message/tool/plan/provider shapes.
 * Message activity references original IDs; standard messages own their content. */
export type Activity = {
  readonly id: string
  readonly namespace: Namespace
  readonly turnId: CanonicalId
  readonly type: ActivityType
  readonly payload: unknown
  readonly sourceSeq: number
  readonly effectsUncertain: boolean
  readonly [key: string]: unknown
} & (
  | { readonly state: "historical"; readonly runId?: CanonicalId }
  | { readonly state: Exclude<ActivityState, "historical">; readonly runId: CanonicalId }
)
export interface Maintenance {
  readonly operationId: CanonicalId
  readonly type: "rollback" | "delete"
  readonly state: "requested" | "draining" | "cleaning" | "failed"
  readonly targetRunId?: CanonicalId
  readonly [key: string]: unknown
}
export interface Retention {
  readonly replaySeconds: number
  readonly replayBytes: number
  readonly oldestSeq: number
  readonly latestSeq: number
  readonly receiptSecondsAfterSettlement: number
  readonly resultExpiresAt?: string
  readonly [key: string]: unknown
}
export interface RecoveryV1 {
  readonly v: 1
  readonly generation: CanonicalId
  readonly throughSeq: number
  readonly eventId: string | null
  readonly revision: string
  readonly checkpoint?: RecoveryCheckpoint
  readonly history: HistoryCoverage
  readonly turn: TurnSummary | null
  readonly run: RunSummary | null
  readonly pending: readonly PendingInput[]
  readonly activity: readonly Activity[]
  readonly maintenance: Maintenance | null
  readonly retention: Retention
  readonly [key: string]: unknown
}
export interface HistoryMetadataV1 {
  readonly v: 1
  readonly generation: CanonicalId
  readonly revision: string
  readonly namespace: Namespace
  readonly lineage: HistoryLineage
  readonly throughSeq: number
  readonly history: HistoryCoverage
  readonly activity: readonly Activity[]
  readonly [key: string]: unknown
}
export type EventCorrelationV1 = {
  readonly v: 1
  readonly generation: CanonicalId
  readonly [key: string]: unknown
} & (
  | { readonly runId: CanonicalId; readonly turnId: CanonicalId }
  | { readonly runId?: never; readonly turnId?: never }
)
export interface SnapshotDeliveryV1 {
  readonly v: 1
  readonly generation: CanonicalId
  readonly delivery: "snapshot"
  readonly throughSeq: number
  readonly [key: string]: unknown
}
export interface ReplayRequestV1 {
  readonly v: 1
  readonly generation: CanonicalId
}
export interface ResyncRequiredV1 {
  readonly v: 1
  readonly code: "resync_required"
  readonly generation: CanonicalId
  readonly oldestSeq: number
  readonly latestSeq: number
  readonly [key: string]: unknown
}
export type B4Event = AspEvent & {
  readonly eventId: string
  readonly seq: number
  readonly b4: EventCorrelationV1
}
export type B4SnapshotEvent = AspEvent & {
  readonly method: "values"
  readonly eventId?: never
  readonly seq?: never
  readonly b4: SnapshotDeliveryV1
}
export type B4EventStreamRequest = AspEventStreamRequest & { readonly b4?: ReplayRequestV1 }
export type B4ResponseMeta = AspResponseMeta & {
  readonly b4?: ReceiptResponseMetaV1 | ResyncRequiredV1 | B4DiagnosticV1
}
/** The command method determines these closed results; correlation is in meta. */
export interface RunStartResponse {
  readonly type: "success"
  readonly id: number
  readonly result: B4RunResult
  readonly meta?: B4ResponseMeta
  readonly [key: string]: unknown
}
export interface StateForkResponse {
  readonly type: "success"
  readonly id: number
  readonly result: B4StateForkResult
  readonly meta?: B4ResponseMeta
  readonly [key: string]: unknown
}
export interface CapabilityProtocolV1 {
  readonly v: 1
  readonly openapi: "0.1.6"
  readonly cddl: "0.0.20"
  readonly profile: "node-sqlite" | "node-postgres" | "host-reduced"
  readonly transports: {
    readonly sse: boolean
    readonly commands: boolean
    readonly websocket: boolean
  }
  readonly backgroundRuns: boolean
  readonly continueAfterDisconnect: boolean
  readonly webhooks: boolean
}
export interface CapabilityRecoveryV1 {
  readonly v: 1
  readonly threadMetadata: "b4"
  readonly historyMetadata: "b4"
  readonly eventEnvelope: "b4"
  readonly replaySeconds: number
  readonly replayBytes: number
  readonly resultSecondsAfterTemporaryCleanup: number
  readonly receiptSecondsAfterSettlement: number
}
export interface CapabilityPermissionsV1 {
  readonly v: 1
  readonly completeSet: true
  readonly decisions: readonly ["once", "always", "deny"]
  readonly grants: "off" | "optional" | "required"
  readonly allowAlways: boolean
  readonly responseSchema: Readonly<Record<string, unknown>>
}
export interface CapabilityControlsV1 {
  readonly v: 1
  readonly injection: boolean
  readonly rollback: boolean
  readonly stateEdit: boolean
  readonly copy: boolean
  readonly fork: boolean
  readonly forkNamespaces: "root" | "declared"
  readonly resume: { readonly update: boolean; readonly goto: boolean; readonly config: boolean }
  readonly systemInjection: boolean
}
export interface CapabilityAguiV1 {
  readonly v: 1
  readonly path: string
  readonly capabilities: NativeAgentCapabilities
}
export interface CapabilityWorkspaceV1 {
  readonly v: 1
  readonly inspect: boolean
  readonly staging: boolean
}
export interface CapabilityStoreV1 {
  readonly v: 1
  readonly generic: boolean
  readonly managedMemory: boolean
  readonly conditionalWrites: true
  readonly approval: boolean
}
export interface B4AgentCapabilities {
  readonly "ap.io.messages"?: boolean
  readonly "ap.io.streaming"?: boolean
  readonly "run.b4.protocol"?: CapabilityProtocolV1
  readonly "run.b4.recovery"?: CapabilityRecoveryV1
  readonly "run.b4.permissions"?: CapabilityPermissionsV1
  readonly "run.b4.controls"?: CapabilityControlsV1
  readonly "run.b4.agui"?: CapabilityAguiV1
  readonly "run.b4.workspace"?: CapabilityWorkspaceV1
  readonly "run.b4.store"?: CapabilityStoreV1
  readonly [key: string]: unknown
}
export interface AgentMetadataV1 {
  readonly v: 1
  readonly kind: "agent" | "chain" | "graph" | "workflow"
  readonly isDefault: boolean
  readonly schemas: AgentSchemasV1
  readonly limits: AgentLimitsV1
  readonly [key: string]: unknown
}
export interface HealthResponse {
  readonly status: "ready"
}
export interface ReadinessResponse {
  readonly status: "ready" | "not_ready"
  readonly checks: Readonly<
    Record<string, { readonly status: "ready" | "not_ready"; readonly code?: string }>
  >
}
export interface WorkspaceCreate {
  readonly sourceDigest: string
  readonly environmentLinks?: readonly { readonly path: string; readonly target: string }[]
  readonly baseline?: "git"
}
export interface SourceBundle {
  readonly version: 1
  readonly digest: string
  readonly files: readonly {
    readonly path: string
    readonly base64: string
    readonly executable: boolean
  }[]
}
export interface SourceStageResponse {
  readonly digest: string
  readonly status: "created" | "held"
}
export interface WorkspaceInspectRequest {
  readonly root?: string
  readonly excludeRootDirectories?: readonly string[]
  readonly expectedRootSymlinks?: Readonly<Record<string, string>>
  readonly ignorePrefixes?: readonly string[]
  readonly maxEntries?: number
  readonly maxFileBytes?: number
  readonly maxTotalBytes?: number
}
export interface WorkspaceInspectResponse {
  readonly threadId: CanonicalId
  readonly sourceDigest: string
  readonly intentDigest: string
  readonly root?: string
  readonly inspection: {
    readonly files: Readonly<Record<string, string>>
    readonly symlinks: Readonly<Record<string, string>>
    readonly totalBytes: number
    readonly entries: number
  }
}
export interface StoreApprovalRequest {
  readonly namespace: Namespace
  readonly key: string
  readonly if_revision: string
}
export interface StoreApprovalResponse {
  readonly item: Item
  readonly action: "activated" | "superseded" | "deduped"
  readonly superseded: readonly Item[]
  readonly removed: readonly { readonly namespace: Namespace; readonly key: string }[]
  readonly replayed: boolean
}

export type B4RunCreate = RunCreate & {
  readonly messages?: readonly B4Message[]
  readonly metadata?: CallerRunMetadata
}
export type B4ThreadCreate = ThreadCreate & {
  readonly metadata?: CallerThreadMetadata
  readonly workspace?: WorkspaceCreate
}
export type B4ThreadPatch = ThreadPatch & {
  readonly messages?: readonly B4Message[]
  readonly metadata?: CallerThreadMetadata
}
export type B4Run = Run & {
  readonly messages?: readonly B4Message[]
  readonly metadata: Readonly<Record<string, unknown>> & { readonly b4: RunMetadataV1 }
}
export type B4Thread = Thread & {
  readonly messages?: readonly B4Message[]
  readonly metadata: Readonly<Record<string, unknown>> & { readonly b4: RecoveryV1 }
}
export type B4ThreadState = ThreadState & {
  readonly messages?: readonly B4Message[]
  readonly metadata: Readonly<Record<string, unknown>> & { readonly b4: HistoryMetadataV1 }
}
export type B4Agent = Agent & {
  readonly metadata: Readonly<Record<string, unknown>> & { readonly b4: AgentMetadataV1 }
  readonly capabilities: B4AgentCapabilities
}
export type B4Command = AspCommand &
  (
    | {
        readonly method: "run.start"
        readonly params: Omit<AspRunStartParams, "metadata"> & {
          readonly metadata?: CallerRunMetadata
        }
        readonly b4?: never
      }
    | {
        readonly method: "input.respond"
        readonly params: AspInputRespondParams & { readonly metadata?: CallerRunMetadata }
        readonly b4?: never
      }
    | {
        readonly method: "input.inject"
        readonly params: AspInputInjectParams & {
          readonly message: AspInputInjectParams["message"] & { readonly b4?: RequestMetadataV1 }
        }
        readonly b4?: never
      }
    | { readonly method: "state.fork"; readonly b4?: RequestMetadataV1 }
    | {
        readonly method: Exclude<
          AspCommand["method"],
          "run.start" | "input.respond" | "input.inject" | "state.fork"
        >
        readonly b4?: never
      }
  )
export type B4CustomData =
  | { readonly name: "b4.input"; readonly payload: InputDispositionV1 }
  | { readonly name: "b4.run"; readonly payload: RunSummary & { readonly v: 1 } }
  | { readonly name: "b4.turn"; readonly payload: TurnSummary & { readonly v: 1 } }
  | { readonly name: "b4.activity"; readonly payload: Activity & { readonly v: 1 } }
  | {
      readonly name: "b4.history"
      readonly payload: {
        readonly v: 1
        readonly revision: string
        readonly reason: "rollback" | "state_edit"
        readonly removedRunIds: readonly CanonicalId[]
      }
    }

/** B4 promises canonical returned IDs; the generic pinned CDDL remains separate. */
export interface B4RunResult {
  readonly runId: CanonicalId
}
export interface B4StateForkResult {
  readonly runId: CanonicalId
  readonly threadId: CanonicalId
}
export interface AgentSearchRequest {
  readonly name?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly limit?: number
  readonly offset?: number
  readonly [key: string]: unknown
}
export interface ThreadHistoryQuery {
  readonly limit?: number
  readonly before?: string
  readonly [key: string]: unknown
}
export type B4ThreadHistoryQuery = ThreadHistoryQuery
export interface RunCancelQuery {
  readonly action?: "interrupt" | "rollback"
  readonly wait?: boolean
  readonly [key: string]: unknown
}
export interface StoreGetQuery {
  readonly key: string
  readonly namespace?: Namespace
  readonly [key: string]: unknown
}
export type B4Message = import("./types.js").Message & {
  readonly role: "user" | "assistant" | "system" | "tool"
}
export interface RunStreamMetadata {
  readonly run: B4Run
}
export interface RunStreamUpdates {
  readonly namespace: Namespace
  readonly node?: string
  readonly values: Readonly<Record<string, unknown>>
}
export interface RunStreamCustom {
  readonly namespace: Namespace
  readonly name?: string
  readonly payload: unknown
}
/** SSE event name selects the public data shape; optional SSE id is a journal cursor. */
export type RunSseEvent =
  | { readonly event: "metadata"; readonly data: RunStreamMetadata; readonly id?: string }
  | {
      readonly event: "values"
      readonly data: Readonly<Record<string, unknown>>
      readonly id?: string
    }
  | { readonly event: "messages"; readonly data: B4Message; readonly id?: string }
  | { readonly event: "updates"; readonly data: RunStreamUpdates; readonly id?: string }
  | { readonly event: "custom"; readonly data: RunStreamCustom; readonly id?: string }
  | {
      readonly event: "end"
      readonly data: B4RunWaitResponse
      readonly id?: string
    }
  | {
      readonly event: "error"
      readonly data: import("./errors.js").B4ErrorResponse
      readonly id?: string
    }

export type B4RunStream = import("./types.js").RunStream & B4RunCreate
export type B4RunSearchRequest = import("./types.js").RunSearchRequest & {
  readonly metadata?: Readonly<Record<string, unknown>> | OperationLookupSelectors
}

/** Public injection disposition. No grant, token, receipt or injected message text.
 * runId is the exact target; reason is a sanitized public explanation. */
export interface InputDispositionV1 {
  readonly v: 1
  readonly inputId: CanonicalId
  readonly runId: CanonicalId
  readonly turnId: CanonicalId
  readonly disposition: ReceiptDisposition
  readonly reason?: string
  readonly grant?: never
  readonly submissionId?: never
  readonly receipt?: never
  readonly message?: never
  readonly [key: string]: unknown
}
/** Counts durably reserved/started attempts, including in-flight work, from zero to five.
 * Omitted when no callback was accepted or its delivery record has expired. */
export interface WebhookDeliverySummary {
  readonly state: "pending" | "delivered" | "failed"
  readonly attempts: number
}
export interface AgentSchemasV1 {
  readonly injectionInput?: Readonly<Record<string, unknown>>
  readonly stateEdit?: Readonly<Record<string, unknown>>
  readonly resumeUpdate?: Readonly<Record<string, unknown>>
  readonly resumeGoto?: Readonly<Record<string, unknown>>
  readonly resumeConfig?: Readonly<Record<string, unknown>>
  readonly recovery?: Readonly<Record<string, unknown>>
  readonly custom?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly [key: string]: unknown
}
export interface AgentInspectionBounds {
  readonly maxEntries: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  readonly [key: string]: unknown
}
/** Effective maxima. A supported feature must advertise its complete applicable group.
 * Omission is never unlimited capacity; every enforced output ceiling must be advertised. */
export interface AgentLimitsV1 {
  readonly requestBytes: number
  readonly pendingPrompts: number
  readonly snapshotBytes?: number
  readonly eventBytes?: number
  readonly inbox?: {
    readonly entries: number
    readonly bytes: number
    readonly textBytes: number
    readonly [key: string]: unknown
  }
  readonly viewer?: {
    readonly events: number
    readonly bytes: number
    readonly [key: string]: unknown
  }
  readonly inspection?: {
    readonly requestBytes: number
    readonly responseBytes: number
    readonly defaults: AgentInspectionBounds
    readonly caps: AgentInspectionBounds
    readonly [key: string]: unknown
  }
  readonly staging?: {
    readonly uploadBytes: number
    readonly quotaBytes: number
    readonly deadlineMs: number
    readonly [key: string]: unknown
  }
  readonly [key: string]: unknown
}

export type B4CheckpointRef = import("./types.js").AspCheckpointRef & { readonly id: CanonicalId }
export type B4Checkpoint = import("./types.js").AspCheckpoint & {
  readonly id: CanonicalId
  readonly parentId?: CanonicalId
}
export type B4StateGetResult = import("./types.js").AspStateGetResult & {
  readonly checkpoint?: B4CheckpointRef
}
export type B4RunWaitResponse = import("./types.js").RunWaitResponse & {
  readonly run?: B4Run
  readonly messages?: readonly B4Message[]
}
