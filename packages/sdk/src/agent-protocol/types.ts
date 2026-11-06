/** Pure wire DTOs. REST: pinned OpenAPI 0.1.6 (reviewed RunStream correction).
 * ASP: pinned CDDL 0.0.20. Runtime identity/closed-map constraints are in the schemas.
 * Unknown application payloads stay opaque; these types do not grant authority. */
export type Agent = {
  readonly agent_id: string
  readonly name: string
  readonly description?: string
  readonly metadata?: { readonly [key: string]: unknown }
  readonly capabilities: {
    readonly "ap.io.messages"?: boolean
    readonly "ap.io.streaming"?: boolean
    readonly [key: string]: unknown
  }
  readonly [key: string]: unknown
}
export type AgentSchema = {
  readonly agent_id: string
  readonly input_schema: { readonly [key: string]: unknown }
  readonly output_schema: { readonly [key: string]: unknown }
  readonly state_schema?: { readonly [key: string]: unknown }
  readonly config_schema?: { readonly [key: string]: unknown }
  readonly [key: string]: unknown
}
export type StreamingChannel =
  | "values"
  | "updates"
  | "messages"
  | "tools"
  | "lifecycle"
  | "input"
  | "checkpoints"
  | "tasks"
  | "custom"
  | `custom:${string}`
export type StreamingNamespace = readonly string[]
export type EventStreamRequest = {
  readonly channels: readonly StreamingChannel[]
  readonly namespaces?: readonly StreamingNamespace[]
  readonly depth?: number
  readonly since?: number
  readonly [key: string]: unknown
}
export type StreamingCommand = {
  readonly id: number
  readonly method: string
  readonly params?: { readonly [key: string]: unknown }
  readonly [key: string]: unknown
}
export type StreamingSuccessResponse = {
  readonly type: "success"
  readonly id: number
  readonly result: { readonly [key: string]: unknown }
  readonly meta?: { readonly appliedThroughSeq?: number; readonly [key: string]: unknown }
  readonly [key: string]: unknown
}
export type StreamingErrorResponse = {
  readonly type: "error"
  readonly id: number | null
  readonly error: string
  readonly message: string
  readonly stacktrace?: string
  readonly meta?: { readonly [key: string]: unknown }
  readonly [key: string]: unknown
}
export type StreamingCommandResponse = StreamingSuccessResponse | StreamingErrorResponse
export type StreamingEvent = {
  readonly type: "event"
  readonly eventId?: string
  readonly seq?: number
  readonly method: string
  readonly params: { readonly [key: string]: unknown }
  readonly [key: string]: unknown
}
export type RunStatus = "pending" | "error" | "success" | "timeout" | "interrupted"
export type StreamMode = "values" | "messages" | "updates" | "custom"
export type RunWaitResponse = {
  readonly run?: Run
  readonly values?: { readonly [key: string]: unknown }
  readonly messages?: readonly Message[]
  readonly [key: string]: unknown
}
export type RunCreate = {
  readonly thread_id?: string
  readonly agent_id?: string
  readonly input?:
    | { readonly [key: string]: unknown }
    | readonly unknown[]
    | string
    | number
    | boolean
    | null
  readonly messages?: readonly Message[]
  readonly metadata?: { readonly [key: string]: unknown }
  readonly config?: {
    readonly tags?: readonly string[]
    readonly recursion_limit?: number
    readonly configurable?: { readonly [key: string]: unknown }
    readonly [key: string]: unknown
  }
  readonly webhook?: string
  readonly on_completion?: "delete" | "keep"
  readonly on_disconnect?: "cancel" | "continue"
  readonly if_not_exists?: "create" | "reject"
  readonly [key: string]: unknown
}
export type RunStream = RunCreate & {
  readonly stream_mode?: StreamMode | readonly StreamMode[]
  readonly [key: string]: unknown
}
export type Run = RunStream & {
  readonly run_id: string
  readonly created_at: string
  readonly updated_at: string
  readonly status: RunStatus
  readonly metadata: Readonly<Record<string, unknown>>
}
export type RunSearchRequest = {
  readonly metadata?: { readonly [key: string]: unknown }
  readonly status?: RunStatus
  readonly thread_id?: string
  readonly agent_id?: string
  readonly limit?: number
  readonly offset?: number
  readonly [key: string]: unknown
}
export type ThreadSearchRequest = {
  readonly metadata?: { readonly [key: string]: unknown }
  readonly values?: { readonly [key: string]: unknown }
  readonly status?: ThreadStatus
  readonly limit?: number
  readonly offset?: number
  readonly [key: string]: unknown
}
export type Thread = {
  readonly thread_id: string
  readonly created_at: string
  readonly updated_at: string
  readonly metadata: { readonly [key: string]: unknown }
  readonly status: ThreadStatus
  readonly values?: { readonly [key: string]: unknown }
  readonly messages?: readonly Message[]
  readonly [key: string]: unknown
}
export type ThreadCheckpoint = { readonly checkpoint_id: string; readonly [key: string]: unknown }
export type ThreadState = {
  readonly checkpoint: ThreadCheckpoint
  readonly values: { readonly [key: string]: unknown }
  readonly messages?: readonly Message[]
  readonly metadata?: { readonly [key: string]: unknown }
  readonly [key: string]: unknown
}
export type ThreadCreate = {
  readonly thread_id?: string
  readonly metadata?: { readonly [key: string]: unknown }
  readonly if_exists?: "raise" | "do_nothing"
  readonly [key: string]: unknown
}
export type ThreadStatus = "idle" | "busy" | "interrupted" | "error"
export type ThreadPatch = {
  readonly checkpoint?: ThreadCheckpoint
  readonly metadata?: { readonly [key: string]: unknown }
  readonly values?: { readonly [key: string]: unknown }
  readonly messages?: readonly Message[]
  readonly [key: string]: unknown
}
export type StorePutRequest = {
  readonly namespace: readonly string[]
  readonly key: string
  readonly value: { readonly [key: string]: unknown }
  readonly [key: string]: unknown
}
export type StoreDeleteRequest = {
  readonly namespace?: readonly string[]
  readonly key: string
  readonly [key: string]: unknown
}
export type StoreSearchRequest = {
  readonly namespace_prefix?: readonly string[] | null
  readonly filter?: { readonly [key: string]: unknown } | null
  readonly limit?: number
  readonly offset?: number
  readonly [key: string]: unknown
}
export type StoreListNamespacesRequest = {
  readonly prefix?: readonly string[]
  readonly suffix?: readonly string[]
  readonly max_depth?: number
  readonly limit?: number
  readonly offset?: number
  readonly [key: string]: unknown
}
export type Item = {
  readonly namespace: readonly string[]
  readonly key: string
  readonly value: { readonly [key: string]: unknown }
  readonly created_at: string
  readonly updated_at: string
  readonly [key: string]: unknown
}
export type Message = {
  readonly role: string
  readonly content:
    | string
    | readonly (
        | {
            readonly text: string
            readonly type: "text"
            readonly metadata?: { readonly [key: string]: unknown }
            readonly [key: string]: unknown
          }
        | {
            readonly type: string
            readonly metadata?: { readonly [key: string]: unknown }
            readonly [key: string]: unknown
          }
      )[]
  readonly id?: string
  readonly metadata?: { readonly [key: string]: unknown }
  readonly [key: string]: unknown
}
export type SearchItemsResponse = {
  readonly items: readonly Item[]
  readonly [key: string]: unknown
}
export type ListNamespaceResponse = readonly (readonly string[])[]
export type ErrorResponse = {
  readonly code?: string
  readonly message?: string
  readonly metadata?: { readonly [key: string]: unknown }
  readonly [key: string]: unknown
}
/** CDDL names are prefixed Asp to distinguish REST Message/ErrorResponse. */
export type Aspjs_int = number
export type Aspjs_uint = number
export type AspNamespace = readonly string[]
export type AspTimestamp = number
export type AspMetadataScalar = null | boolean | number | string
export type AspMessageRole = "ai" | "human" | "system"
export type AspMessageMetadata = {
  readonly provider?: string
  readonly model?: string
  readonly modelType?: string
  readonly runId?: string
  readonly threadId?: string
  readonly systemFingerprint?: string
  readonly serviceTier?: string
  readonly [key: string]: AspMetadataScalar
}
export type AspContentBlock =
  | AspTextContentBlock
  | AspInvalidToolCall
  | AspReasoningContentBlock
  | AspNonStandardContentBlock
  | AspDataContentBlock
  | AspToolContentBlock
export type AspDataContentBlock =
  | AspImageContentBlock
  | AspVideoContentBlock
  | AspAudioContentBlock
  | AspFileContentBlock
export type AspToolContentBlock =
  | AspToolCall
  | AspToolCallChunk
  | AspServerToolCall
  | AspServerToolCallChunk
  | AspServerToolResult
export type AspFinalizedContentBlock =
  | AspTextContentBlock
  | AspReasoningContentBlock
  | AspToolCall
  | AspInvalidToolCall
  | AspServerToolCall
  | AspServerToolResult
  | AspDataContentBlock
  | AspNonStandardContentBlock
export type AspBlockIndex = Aspjs_int | string
export type AspTextContentBlock = {
  readonly type: "text"
  readonly text: string
  readonly id?: string
  readonly index?: AspBlockIndex
  readonly annotations?: readonly AspAnnotation[]
  readonly [key: string]: unknown
}
export type AspAnnotation = AspCitation | AspNonStandardAnnotation
export type AspCitation = {
  readonly type: "citation"
  readonly id?: string
  readonly url?: string
  readonly title?: string
  readonly startIndex?: number
  readonly endIndex?: number
  readonly citedText?: string
  readonly [key: string]: unknown
}
export type AspNonStandardAnnotation = {
  readonly type: "non_standard_annotation"
  readonly id?: string
  readonly value: { readonly [key: string]: unknown }
  readonly [key: string]: unknown
}
export type AspReasoningContentBlock = {
  readonly type: "reasoning"
  readonly reasoning?: string
  readonly id?: string
  readonly index?: AspBlockIndex
  readonly [key: string]: unknown
}
export type AspToolCall = {
  readonly type: "tool_call"
  readonly id: string | null
  readonly name: string
  readonly args: { readonly [key: string]: unknown }
  readonly index?: AspBlockIndex
  readonly [key: string]: unknown
}
export type AspToolCallChunk = {
  readonly type: "tool_call_chunk"
  readonly id: string | null
  readonly name: string | null
  readonly args: string | null
  readonly index?: AspBlockIndex
  readonly [key: string]: unknown
}
export type AspInvalidToolCall = {
  readonly type: "invalid_tool_call"
  readonly id: string | null
  readonly name: string | null
  readonly args: string | null
  readonly error: string | null
  readonly index?: AspBlockIndex
  readonly [key: string]: unknown
}
export type AspServerToolCall = {
  readonly type: "server_tool_call"
  readonly id: string
  readonly name: string
  readonly args: { readonly [key: string]: unknown }
  readonly index?: AspBlockIndex
  readonly [key: string]: unknown
}
export type AspServerToolCallChunk = {
  readonly type: "server_tool_call_chunk"
  readonly id?: string
  readonly name?: string
  readonly args?: string
  readonly index?: AspBlockIndex
  readonly [key: string]: unknown
}
export type AspServerToolResult = {
  readonly type: "server_tool_result"
  readonly toolCallId: string
  readonly status: "success" | "error"
  readonly id?: string
  readonly output?: unknown
  readonly index?: AspBlockIndex
  readonly [key: string]: unknown
}
export type AspImageContentBlock = {
  readonly type: "image"
  readonly id?: string
  readonly fileId?: string
  readonly url?: string
  readonly base64?: string
  readonly mimeType?: string
  readonly index?: AspBlockIndex
  readonly [key: string]: unknown
}
export type AspAudioContentBlock = {
  readonly type: "audio"
  readonly id?: string
  readonly fileId?: string
  readonly url?: string
  readonly base64?: string
  readonly mimeType?: string
  readonly index?: AspBlockIndex
  readonly [key: string]: unknown
}
export type AspVideoContentBlock = {
  readonly type: "video"
  readonly id?: string
  readonly fileId?: string
  readonly url?: string
  readonly base64?: string
  readonly mimeType?: string
  readonly index?: AspBlockIndex
  readonly [key: string]: unknown
}
export type AspFileContentBlock = {
  readonly type: "file"
  readonly id?: string
  readonly fileId?: string
  readonly url?: string
  readonly base64?: string
  readonly mimeType?: string
  readonly index?: AspBlockIndex
  readonly [key: string]: unknown
}
export type AspNonStandardContentBlock = {
  readonly type: "non_standard"
  readonly value: { readonly [key: string]: unknown }
  readonly id?: string
  readonly index?: AspBlockIndex
  readonly [key: string]: unknown
}
export type AspTextDelta = {
  readonly type: "text-delta"
  readonly text: string
  readonly [key: string]: unknown
}
export type AspReasoningDelta = {
  readonly type: "reasoning-delta"
  readonly reasoning: string
  readonly [key: string]: unknown
}
export type AspDataDelta = {
  readonly type: "data-delta"
  readonly data: string
  readonly encoding?: "base64"
  readonly [key: string]: unknown
}
export type AspBlockDeltaFields = { readonly type: string; readonly [key: string]: unknown }
export type AspBlockDelta = {
  readonly type: "block-delta"
  readonly fields: AspBlockDeltaFields
  readonly [key: string]: unknown
}
export type AspToolCallDelta = {
  readonly type: "tool-call-delta"
  readonly args: string
  readonly [key: string]: unknown
}
export type AspContentBlockDelta =
  | AspTextDelta
  | AspReasoningDelta
  | AspDataDelta
  | AspBlockDelta
  | AspToolCallDelta
export type AspCommand = {
  readonly id: Aspjs_uint
  readonly [key: string]: unknown
} & AspCommandData
export type AspCommandData =
  | AspRunCommand
  | AspSubscriptionCommand
  | AspAgentCommand
  | AspInputCommand
  | AspStateCommand
export type AspMessage = AspCommandResponse | AspErrorResponse | AspEvent
export type AspCommandResponse = {
  readonly type: "success"
  readonly id: Aspjs_uint
  readonly result: AspResultData
  readonly meta?: AspResponseMeta
  readonly [key: string]: unknown
}
export type AspErrorResponse = {
  readonly type: "error"
  readonly id: Aspjs_uint | null
  readonly error: AspErrorCode
  readonly message: string
  readonly stacktrace?: string
  readonly meta?: AspResponseMeta
  readonly [key: string]: unknown
}
export type AspEvent = {
  readonly type: "event"
  readonly eventId?: string
  readonly seq?: Aspjs_uint
  readonly [key: string]: unknown
} & AspEventData
export type AspResultData =
  | AspRunResult
  | AspSubscriptionResult
  | AspAgentResult
  | AspInputResult
  | AspStateResult
  | AspEmptyResult
export type AspEmptyResult = { readonly [key: string]: unknown }
export type AspErrorCode =
  | "invalid_argument"
  | "unknown_command"
  | "unknown_error"
  | "no_such_run"
  | "no_such_subscription"
  | "no_such_namespace"
  | "no_such_interrupt"
  | "no_such_checkpoint"
  | "permission_denied"
  | "not_supported"
export type AspResponseMeta = {
  readonly appliedThroughSeq?: Aspjs_uint
  readonly [key: string]: unknown
}
export type AspRunCommand = Asprun_start
export type Asprun_start = { readonly method: "run.start"; readonly params: AspRunStartParams }
export type AspLangSmithTracer = { readonly projectName?: string; readonly exampleId?: string }
export type AspRunStartParams = {
  readonly assistantId: string
  readonly input: unknown
  readonly config?: { readonly [key: string]: unknown }
  readonly metadata?: { readonly [key: string]: unknown }
  readonly langsmithTracer?: AspLangSmithTracer
}
export type AspRunResult = { readonly runId?: string }
export type AspChannel =
  | "values"
  | "updates"
  | "messages"
  | "tools"
  | "lifecycle"
  | "input"
  | "checkpoints"
  | "tasks"
  | "custom"
  | `custom:${string}`
export type AspEventStreamRequest = {
  readonly channels: readonly [AspChannel, ...AspChannel[]]
  readonly namespaces?: readonly AspNamespace[]
  readonly depth?: number
  readonly since?: Aspjs_uint
  readonly [key: string]: unknown
}
export type AspSubscriptionCommand =
  | Aspsubscription_subscribe
  | Aspsubscription_unsubscribe
  | Aspsubscription_reconnect
export type Aspsubscription_subscribe = {
  readonly method: "subscription.subscribe"
  readonly params: AspSubscribeParams
}
export type AspSubscribeParams = {
  readonly channels: readonly [AspChannel, ...AspChannel[]]
  readonly namespaces?: readonly AspNamespace[]
  readonly depth?: number
  readonly [key: string]: unknown
}
export type AspSubscribeResult = {
  readonly subscriptionId: string
  readonly replayedEvents?: number
  readonly [key: string]: unknown
}
export type Aspsubscription_unsubscribe = {
  readonly method: "subscription.unsubscribe"
  readonly params: AspUnsubscribeParams
}
export type AspUnsubscribeParams = {
  readonly subscriptionId: string
  readonly [key: string]: unknown
}
export type Aspsubscription_reconnect = {
  readonly method: "subscription.reconnect"
  readonly params: AspReconnectParams
}
export type AspReconnectParams = {
  readonly runId: string
  readonly lastEventId?: string
  readonly subscriptions?: readonly string[]
  readonly [key: string]: unknown
}
export type AspReconnectResult = {
  readonly restored: boolean
  readonly missedEvents?: number
  readonly currentNamespaces?: readonly AspAgentStatusEntry[]
  readonly [key: string]: unknown
}
export type AspAgentStatusEntry = {
  readonly namespace: AspNamespace
  readonly status: AspAgentStatus
  readonly [key: string]: unknown
}
export type AspSubscriptionResult = AspSubscribeResult | AspReconnectResult | AspEmptyResult
export type AspAgentCommand = Aspagent_getTree
export type Aspagent_getTree = {
  readonly method: "agent.getTree"
  readonly params: AspAgentGetTreeParams
}
export type AspAgentGetTreeParams = { readonly runId?: string }
export type AspAgentTreeNode = {
  readonly namespace: AspNamespace
  readonly status: AspAgentStatus
  readonly graphName: string
  readonly children?: readonly AspAgentTreeNode[]
  readonly metadata?: { readonly [key: string]: unknown }
}
export type AspAgentResult = { readonly tree: AspAgentTreeNode }
export type AspAgentStatus = "started" | "running" | "completed" | "failed" | "interrupted"
export type AspEventData =
  | AspLifecycleEvent
  | AspMessagesEvent
  | AspToolsEvent
  | AspInputEvent
  | AspValuesEvent
  | AspUpdatesEvent
  | AspCheckpointsEvent
  | AspCustomEvent
  | AspTasksEvent
export type AspLifecycleEvent = {
  readonly method: "lifecycle"
  readonly params: {
    readonly namespace: AspNamespace
    readonly timestamp: AspTimestamp
    readonly data: AspLifecycleData
  }
}
export type AspLifecycleCause =
  | AspLifecycleCauseToolCall
  | AspLifecycleCauseSend
  | AspLifecycleCauseEdge
export type AspLifecycleCauseToolCall = { readonly type: "toolCall"; readonly toolCallId: string }
export type AspLifecycleCauseSend = { readonly type: "send"; readonly fromNode: string }
export type AspLifecycleCauseEdge = { readonly type: "edge"; readonly fromNode: string }
export type AspLifecycleData = {
  readonly event: AspAgentStatus
  readonly graphName?: string
  readonly cause?: AspLifecycleCause
  readonly error?: string
  readonly checkpoint?: AspCheckpointRef
}
export type AspMessagesEvent = {
  readonly method: "messages"
  readonly params: {
    readonly namespace: AspNamespace
    readonly timestamp: AspTimestamp
    readonly node?: string
    readonly data: AspMessagesData
  }
}
export type AspMessagesData =
  | AspMessageStartData
  | AspContentBlockStartData
  | AspContentBlockDeltaData
  | AspContentBlockFinishData
  | AspMessageFinishData
  | AspMessageErrorData
export type AspMessageStartData = {
  readonly event: "message-start"
  readonly role: AspMessageRole
  readonly id: string
  readonly metadata?: AspMessageMetadata
  readonly [key: string]: unknown
}
export type AspContentBlockStartData = {
  readonly event: "content-block-start"
  readonly index: number
  readonly content: AspContentBlock
  readonly [key: string]: unknown
}
export type AspContentBlockDeltaData = {
  readonly event: "content-block-delta"
  readonly index: number
  readonly delta: AspContentBlockDelta
  readonly [key: string]: unknown
}
export type AspContentBlockFinishData = {
  readonly event: "content-block-finish"
  readonly index: number
  readonly content: AspFinalizedContentBlock
  readonly [key: string]: unknown
}
export type AspMessageFinishData = {
  readonly event: "message-finish"
  readonly usage?: AspUsageInfo
  readonly [key: string]: unknown
}
export type AspInputTokenDetails = {
  readonly audio?: number
  readonly cacheCreation?: number
  readonly cacheRead?: number
  readonly [key: string]: unknown
}
export type AspOutputTokenDetails = {
  readonly audio?: number
  readonly reasoning?: number
  readonly [key: string]: unknown
}
export type AspUsageInfo = {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly inputTokenDetails?: AspInputTokenDetails
  readonly outputTokenDetails?: AspOutputTokenDetails
  readonly [key: string]: unknown
}
export type AspMessageErrorData = {
  readonly event: "error"
  readonly message: string
  readonly code?: string
  readonly [key: string]: unknown
}
export type AspToolsEvent = {
  readonly method: "tools"
  readonly params: {
    readonly namespace: AspNamespace
    readonly timestamp: AspTimestamp
    readonly node?: string
    readonly data: AspToolsData
  }
}
export type AspToolsData =
  | AspToolStartedData
  | AspToolOutputDeltaData
  | AspToolFinishedData
  | AspToolErrorData
export type AspToolStartedData = {
  readonly event: "tool-started"
  readonly toolCallId: string
  readonly toolName: string
  readonly input?: unknown
  readonly [key: string]: unknown
}
export type AspToolOutputDeltaData = {
  readonly event: "tool-output-delta"
  readonly toolCallId: string
  readonly delta: string
  readonly [key: string]: unknown
}
export type AspToolFinishedData = {
  readonly event: "tool-finished"
  readonly toolCallId: string
  readonly output: unknown
  readonly [key: string]: unknown
}
export type AspToolErrorData = {
  readonly event: "tool-error"
  readonly toolCallId: string
  readonly message: string
  readonly code?: string
  readonly [key: string]: unknown
}
export type AspInputCommand = Aspinput_respond | Aspinput_inject
export type Aspinput_respond = {
  readonly method: "input.respond"
  readonly params: AspInputRespondParams
}
export type AspInputRespondParams = AspInputRespondOne | AspInputRespondMany
export type AspRunSend = { readonly node: string; readonly input?: unknown }
export type AspGoto = string | AspRunSend | readonly (string | AspRunSend)[]
export type AspInputRespondOne = {
  readonly namespace: AspNamespace
  readonly interruptId: string
  readonly response: unknown
  readonly update?: { readonly [key: string]: unknown }
  readonly goto?: AspGoto
  readonly config?: { readonly [key: string]: unknown }
  readonly metadata?: { readonly [key: string]: unknown }
}
export type AspInputRespondMany = {
  readonly responses: readonly [AspInputRespondEntry, ...AspInputRespondEntry[]]
  readonly update?: { readonly [key: string]: unknown }
  readonly goto?: AspGoto
  readonly config?: { readonly [key: string]: unknown }
  readonly metadata?: { readonly [key: string]: unknown }
}
export type AspInputRespondEntry = {
  readonly namespace: AspNamespace
  readonly interruptId: string
  readonly response: unknown
}
export type Aspinput_inject = {
  readonly method: "input.inject"
  readonly params: AspInputInjectParams
}
export type AspInputInjectParams = {
  readonly namespace: AspNamespace
  readonly message: AspInputMessage
}
export type AspInputMessage = {
  readonly role: "user" | "system"
  readonly content: string
  readonly name?: string
  readonly [key: string]: unknown
}
export type AspInputResult = AspEmptyResult
export type AspInputEvent = {
  readonly method: "input.requested"
  readonly params: {
    readonly namespace: AspNamespace
    readonly timestamp: AspTimestamp
    readonly data: AspInputRequestedData
  }
}
export type AspInputRequestedData = {
  readonly interruptId: string
  readonly payload: unknown
  readonly [key: string]: unknown
}
export type AspStateCommand = Aspstate_get | Aspstate_listCheckpoints | Aspstate_fork
export type Aspstate_get = { readonly method: "state.get"; readonly params: AspStateGetParams }
export type AspStateGetParams = {
  readonly namespace: AspNamespace
  readonly keys?: readonly string[]
}
export type AspStateGetResult = {
  readonly values: { readonly [key: string]: unknown }
  readonly checkpoint?: AspCheckpointRef
}
export type Aspstate_listCheckpoints = {
  readonly method: "state.listCheckpoints"
  readonly params: AspListCheckpointsParams
}
export type AspListCheckpointsParams = {
  readonly namespace?: AspNamespace
  readonly limit?: number
  readonly before?: string
}
export type AspListCheckpointsResult = { readonly checkpoints: readonly AspCheckpointSummary[] }
export type AspCheckpointSummary = {
  readonly id: string
  readonly timestamp: string
  readonly step: number
  readonly nodeName?: string
  readonly metadata?: { readonly [key: string]: unknown }
}
export type AspCheckpointRef = { readonly id: string; readonly ns?: string }
export type Aspstate_fork = { readonly method: "state.fork"; readonly params: AspStateForkParams }
export type AspStateForkParams = {
  readonly checkpointId: string
  readonly input?: unknown
  readonly config?: { readonly [key: string]: unknown }
}
export type AspStateForkResult = { readonly runId: string; readonly threadId: string }
export type AspStateResult =
  | AspStateGetResult
  | AspListCheckpointsResult
  | AspStateForkResult
  | AspEmptyResult
export type AspValuesEvent = {
  readonly method: "values"
  readonly params: {
    readonly namespace: AspNamespace
    readonly timestamp: AspTimestamp
    readonly data: unknown
  }
}
export type AspCheckpointsEvent = {
  readonly method: "checkpoints"
  readonly params: {
    readonly namespace: AspNamespace
    readonly timestamp: AspTimestamp
    readonly data: AspCheckpoint
  }
}
export type AspCheckpoint = {
  readonly id: string
  readonly parentId?: string
  readonly step: number
  readonly source: AspCheckpointSource
  readonly [key: string]: unknown
}
export type AspCheckpointSource = "input" | "loop" | "update" | "fork"
export type AspUpdatesEvent = {
  readonly method: "updates"
  readonly params: {
    readonly namespace: AspNamespace
    readonly timestamp: AspTimestamp
    readonly data: AspUpdatesData
  }
}
export type AspUpdatesData = {
  readonly node?: string
  readonly values: { readonly [key: string]: unknown }
  readonly [key: string]: unknown
}
export type AspCustomEvent = {
  readonly method: "custom"
  readonly params: {
    readonly namespace: AspNamespace
    readonly timestamp: AspTimestamp
    readonly data: AspCustomData
  }
}
export type AspCustomData = {
  readonly name?: string
  readonly payload: unknown
  readonly [key: string]: unknown
}
export type AspTasksEvent = {
  readonly method: "tasks"
  readonly params: {
    readonly namespace: AspNamespace
    readonly timestamp: AspTimestamp
    readonly data: unknown
  }
}

/** Native capability DTOs: AG-UI 08eae9dc13546e91272efb2d0ef863e21acc6ee3. */
export type NativeAgentCapabilities = {
  readonly identity?: NativeIdentityCapabilities
  readonly transport?: NativeTransportCapabilities
  readonly tools?: NativeToolsCapabilities
  readonly output?: NativeOutputCapabilities
  readonly state?: NativeStateCapabilities
  readonly multiAgent?: NativeMultiAgentCapabilities
  readonly reasoning?: NativeReasoningCapabilities
  readonly multimodal?: NativeMultimodalCapabilities
  readonly execution?: NativeExecutionCapabilities
  readonly humanInTheLoop?: NativeHumanInTheLoopCapabilities
  readonly custom?: { readonly [key: string]: unknown }
}
export type NativeIdentityCapabilities = {
  readonly name?: string
  readonly type?: string
  readonly description?: string
  readonly version?: string
  readonly provider?: string
  readonly documentationUrl?: string
  readonly metadata?: NativeMetadata
}
export type NativeMetadata = { readonly [key: string]: unknown }
export type NativeTransportCapabilities = {
  readonly streaming?: boolean
  readonly websocket?: boolean
  readonly httpBinary?: boolean
  readonly pushNotifications?: boolean
  readonly resumable?: boolean
}
export type NativeToolsCapabilities = {
  readonly supported?: boolean
  readonly items?: readonly NativeTool[]
  readonly parallelCalls?: boolean
  readonly clientProvided?: boolean
}
export type NativeTool = {
  readonly name: string
  readonly description: string
  readonly parameters?: unknown
  readonly metadata?: NativeMetadata
}
export type NativeOutputCapabilities = {
  readonly structuredOutput?: boolean
  readonly supportedMimeTypes?: readonly string[]
}
export type NativeStateCapabilities = {
  readonly snapshots?: boolean
  readonly deltas?: boolean
  readonly memory?: boolean
  readonly persistentState?: boolean
}
export type NativeMultiAgentCapabilities = {
  readonly supported?: boolean
  readonly delegation?: boolean
  readonly handoffs?: boolean
  readonly subagents?: readonly NativeSubagentInfo[]
}
export type NativeSubagentInfo = { readonly name: string; readonly description?: string }
export type NativeReasoningCapabilities = {
  readonly supported?: boolean
  readonly streaming?: boolean
  readonly encrypted?: boolean
}
export type NativeMultimodalCapabilities = {
  readonly input?: NativeMultimodalInputCapabilities
  readonly output?: NativeMultimodalOutputCapabilities
}
export type NativeMultimodalInputCapabilities = {
  readonly image?: boolean
  readonly audio?: boolean
  readonly video?: boolean
  readonly pdf?: boolean
  readonly file?: boolean
}
export type NativeMultimodalOutputCapabilities = {
  readonly image?: boolean
  readonly audio?: boolean
}
export type NativeExecutionCapabilities = {
  readonly codeExecution?: boolean
  readonly sandboxed?: boolean
  readonly maxIterations?: number
  readonly maxExecutionTime?: number
}
export type NativeHumanInTheLoopCapabilities = {
  readonly supported?: boolean
  readonly approvals?: boolean
  readonly interventions?: boolean
  readonly feedback?: boolean
  readonly interrupts?: boolean
  readonly approveWithEdits?: boolean
}
