/** JSON Schema 2020-12 definitions. ASP maps follow the pinned CDDL, including
 * its closed maps. REST definitions are read from the hash-guarded OpenAPI at build.
 * B4 additions implement approved wire §§3–14; they are not upstream corrections.
 * Native capability definitions are translated from AG-UI 1.0 at the separate pin.
 * Application payloads deliberately remain unconstrained. */
export type ContractSchema = Readonly<Record<string, unknown>>
const ref = (name: string): ContractSchema => ({ $ref: `#/$defs/${name}` })
const object = (
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
  additionalProperties: unknown = true,
): ContractSchema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties,
})
const string: ContractSchema = { type: "string" }
const boolean: ContractSchema = { type: "boolean" }
const uint: ContractSchema = { type: "integer", minimum: 0, maximum: 9007199254740991 }
const uuid: ContractSchema = {
  type: "string",
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
}
const date: ContractSchema = { type: "string", format: "date-time", pattern: "(?:[Zz]|[+]00:00)$" }
const array = (items: unknown): ContractSchema => ({ type: "array", items })
const enumeration = (...values: readonly string[]): ContractSchema => ({
  type: "string",
  enum: values,
})
const nullable = (schema: unknown): ContractSchema => ({ anyOf: [schema, { type: "null" }] })
const v = { const: 1 }
const namespace = array(string)
const token = {
  anyOf: [
    object({ submissionKind: { const: "b4" }, submissionId: uuid }, [
      "submissionKind",
      "submissionId",
    ]),
    object({ submissionKind: { const: "agui" }, submissionId: string }, [
      "submissionKind",
      "submissionId",
    ]),
  ],
}
const runReason = enumeration(
  "completed",
  "permission",
  "user_stop",
  "server_shutdown",
  "deadline",
  "execution_error",
  "execution_lost",
  "client_disconnect",
)
const continuation = enumeration("none", "waiting", "closed")
const phase = enumeration("accepted", "running", "settled")
const disposition = enumeration("accepted", "applied", "not_applied")
const reservedSelectors = {
  not: { enum: ["b4.submissionId", "b4.submissionKind", "b4.operationThreadId", "b4.targetRunId"] },
}

// Required-path conditions do not accidentally activate for omitted capabilities.
const atPath = (path: readonly string[], leaf: ContractSchema): ContractSchema =>
  path.reduceRight((schema, key) => object({ [key]: schema }, [key]), leaf)
const advertises = (
  condition: ContractSchema,
  schemas: readonly string[],
  limits: readonly string[],
): ContractSchema => ({
  if: condition,
  // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
  then: atPath(
    ["metadata", "b4"],
    object({ schemas: object({}, schemas), limits: object({}, limits) }),
  ),
})

export const AGENT_PROTOCOL_DEFINITIONS: Readonly<Record<string, ContractSchema>> = {
  Aspjs_int: { type: "integer", minimum: -9007199254740991, maximum: 9007199254740991 },
  Aspjs_uint: { type: "integer", minimum: 0, maximum: 9007199254740991 },
  AspNamespace: { type: "array", items: { type: "string" } },
  AspTimestamp: { type: "integer", minimum: 0 },
  AspMetadataScalar: {
    anyOf: [
      { type: "null" },
      { type: "boolean" },
      { type: "integer" },
      { type: "number" },
      { type: "string" },
    ],
  },
  AspMessageRole: { anyOf: [{ const: "ai" }, { const: "human" }, { const: "system" }] },
  AspMessageMetadata: object(
    {
      provider: { type: "string" },
      model: { type: "string" },
      modelType: { type: "string" },
      runId: { type: "string" },
      threadId: { type: "string" },
      systemFingerprint: { type: "string" },
      serviceTier: { type: "string" },
    },
    [],
    ref("AspMetadataScalar"),
  ),
  AspContentBlock: {
    anyOf: [
      ref("AspTextContentBlock"),
      ref("AspInvalidToolCall"),
      ref("AspReasoningContentBlock"),
      ref("AspNonStandardContentBlock"),
      ref("AspDataContentBlock"),
      ref("AspToolContentBlock"),
    ],
  },
  AspDataContentBlock: {
    anyOf: [
      ref("AspImageContentBlock"),
      ref("AspVideoContentBlock"),
      ref("AspAudioContentBlock"),
      ref("AspFileContentBlock"),
    ],
  },
  AspToolContentBlock: {
    anyOf: [
      ref("AspToolCall"),
      ref("AspToolCallChunk"),
      ref("AspServerToolCall"),
      ref("AspServerToolCallChunk"),
      ref("AspServerToolResult"),
    ],
  },
  AspFinalizedContentBlock: {
    anyOf: [
      ref("AspTextContentBlock"),
      ref("AspReasoningContentBlock"),
      ref("AspToolCall"),
      ref("AspInvalidToolCall"),
      ref("AspServerToolCall"),
      ref("AspServerToolResult"),
      ref("AspDataContentBlock"),
      ref("AspNonStandardContentBlock"),
    ],
  },
  AspBlockIndex: { anyOf: [ref("Aspjs_int"), { type: "string" }] },
  AspTextContentBlock: object(
    {
      type: { const: "text" },
      text: { type: "string" },
      id: { type: "string" },
      index: ref("AspBlockIndex"),
      annotations: { type: "array", items: ref("AspAnnotation") },
    },
    ["type", "text"],
    true,
  ),
  AspAnnotation: { anyOf: [ref("AspCitation"), ref("AspNonStandardAnnotation")] },
  AspCitation: object(
    {
      type: { const: "citation" },
      id: { type: "string" },
      url: { type: "string" },
      title: { type: "string" },
      startIndex: { type: "integer", minimum: 0 },
      endIndex: { type: "integer", minimum: 0 },
      citedText: { type: "string" },
    },
    ["type"],
    true,
  ),
  AspNonStandardAnnotation: object(
    {
      type: { const: "non_standard_annotation" },
      id: { type: "string" },
      value: object({}, [], {}),
    },
    ["type", "value"],
    true,
  ),
  AspReasoningContentBlock: object(
    {
      type: { const: "reasoning" },
      reasoning: { type: "string" },
      id: { type: "string" },
      index: ref("AspBlockIndex"),
    },
    ["type"],
    true,
  ),
  AspToolCall: object(
    {
      type: { const: "tool_call" },
      id: { anyOf: [{ type: "string" }, { type: "null" }] },
      name: { type: "string" },
      args: object({}, [], {}),
      index: ref("AspBlockIndex"),
    },
    ["type", "id", "name", "args"],
    true,
  ),
  AspToolCallChunk: object(
    {
      type: { const: "tool_call_chunk" },
      id: { anyOf: [{ type: "string" }, { type: "null" }] },
      name: { anyOf: [{ type: "string" }, { type: "null" }] },
      args: { anyOf: [{ type: "string" }, { type: "null" }] },
      index: ref("AspBlockIndex"),
    },
    ["type", "id", "name", "args"],
    true,
  ),
  AspInvalidToolCall: object(
    {
      type: { const: "invalid_tool_call" },
      id: { anyOf: [{ type: "string" }, { type: "null" }] },
      name: { anyOf: [{ type: "string" }, { type: "null" }] },
      args: { anyOf: [{ type: "string" }, { type: "null" }] },
      error: { anyOf: [{ type: "string" }, { type: "null" }] },
      index: ref("AspBlockIndex"),
    },
    ["type", "id", "name", "args", "error"],
    true,
  ),
  AspServerToolCall: object(
    {
      type: { const: "server_tool_call" },
      id: { type: "string" },
      name: { type: "string" },
      args: object({}, [], {}),
      index: ref("AspBlockIndex"),
    },
    ["type", "id", "name", "args"],
    true,
  ),
  AspServerToolCallChunk: object(
    {
      type: { const: "server_tool_call_chunk" },
      id: { type: "string" },
      name: { type: "string" },
      args: { type: "string" },
      index: ref("AspBlockIndex"),
    },
    ["type"],
    true,
  ),
  AspServerToolResult: object(
    {
      type: { const: "server_tool_result" },
      toolCallId: { type: "string" },
      status: { anyOf: [{ const: "success" }, { const: "error" }] },
      id: { type: "string" },
      output: {},
      index: ref("AspBlockIndex"),
    },
    ["type", "toolCallId", "status"],
    true,
  ),
  AspImageContentBlock: object(
    {
      type: { const: "image" },
      id: { type: "string" },
      fileId: { type: "string" },
      url: { type: "string" },
      base64: { type: "string" },
      mimeType: { type: "string" },
      index: ref("AspBlockIndex"),
    },
    ["type"],
    true,
  ),
  AspAudioContentBlock: object(
    {
      type: { const: "audio" },
      id: { type: "string" },
      fileId: { type: "string" },
      url: { type: "string" },
      base64: { type: "string" },
      mimeType: { type: "string" },
      index: ref("AspBlockIndex"),
    },
    ["type"],
    true,
  ),
  AspVideoContentBlock: object(
    {
      type: { const: "video" },
      id: { type: "string" },
      fileId: { type: "string" },
      url: { type: "string" },
      base64: { type: "string" },
      mimeType: { type: "string" },
      index: ref("AspBlockIndex"),
    },
    ["type"],
    true,
  ),
  AspFileContentBlock: object(
    {
      type: { const: "file" },
      id: { type: "string" },
      fileId: { type: "string" },
      url: { type: "string" },
      base64: { type: "string" },
      mimeType: { type: "string" },
      index: ref("AspBlockIndex"),
    },
    ["type"],
    true,
  ),
  AspNonStandardContentBlock: object(
    {
      type: { const: "non_standard" },
      value: object({}, [], {}),
      id: { type: "string" },
      index: ref("AspBlockIndex"),
    },
    ["type", "value"],
    true,
  ),
  AspTextDelta: object(
    { type: { const: "text-delta" }, text: { type: "string" } },
    ["type", "text"],
    true,
  ),
  AspReasoningDelta: object(
    { type: { const: "reasoning-delta" }, reasoning: { type: "string" } },
    ["type", "reasoning"],
    true,
  ),
  AspDataDelta: object(
    { type: { const: "data-delta" }, data: { type: "string" }, encoding: { const: "base64" } },
    ["type", "data"],
    true,
  ),
  AspBlockDeltaFields: object({ type: { type: "string" } }, ["type"], {}),
  AspBlockDelta: object(
    { type: { const: "block-delta" }, fields: ref("AspBlockDeltaFields") },
    ["type", "fields"],
    true,
  ),
  AspToolCallDelta: object(
    { type: { const: "tool-call-delta" }, args: { type: "string" } },
    ["type", "args"],
    true,
  ),
  AspContentBlockDelta: {
    anyOf: [
      ref("AspTextDelta"),
      ref("AspReasoningDelta"),
      ref("AspDataDelta"),
      ref("AspBlockDelta"),
      ref("AspToolCallDelta"),
    ],
  },
  AspCommand: {
    anyOf: [
      object(
        { id: ref("Aspjs_uint"), method: { const: "run.start" }, params: ref("AspRunStartParams") },
        ["id", "method", "params"],
        true,
      ),
      object(
        {
          id: ref("Aspjs_uint"),
          method: { const: "subscription.subscribe" },
          params: ref("AspSubscribeParams"),
        },
        ["id", "method", "params"],
        true,
      ),
      object(
        {
          id: ref("Aspjs_uint"),
          method: { const: "subscription.unsubscribe" },
          params: ref("AspUnsubscribeParams"),
        },
        ["id", "method", "params"],
        true,
      ),
      object(
        {
          id: ref("Aspjs_uint"),
          method: { const: "subscription.reconnect" },
          params: ref("AspReconnectParams"),
        },
        ["id", "method", "params"],
        true,
      ),
      object(
        {
          id: ref("Aspjs_uint"),
          method: { const: "agent.getTree" },
          params: ref("AspAgentGetTreeParams"),
        },
        ["id", "method", "params"],
        true,
      ),
      object(
        {
          id: ref("Aspjs_uint"),
          method: { const: "input.respond" },
          params: ref("AspInputRespondParams"),
        },
        ["id", "method", "params"],
        true,
      ),
      object(
        {
          id: ref("Aspjs_uint"),
          method: { const: "input.inject" },
          params: ref("AspInputInjectParams"),
        },
        ["id", "method", "params"],
        true,
      ),
      object(
        { id: ref("Aspjs_uint"), method: { const: "state.get" }, params: ref("AspStateGetParams") },
        ["id", "method", "params"],
        true,
      ),
      object(
        {
          id: ref("Aspjs_uint"),
          method: { const: "state.listCheckpoints" },
          params: ref("AspListCheckpointsParams"),
        },
        ["id", "method", "params"],
        true,
      ),
      object(
        {
          id: ref("Aspjs_uint"),
          method: { const: "state.fork" },
          params: ref("AspStateForkParams"),
        },
        ["id", "method", "params"],
        true,
      ),
    ],
  },
  AspCommandData: {
    anyOf: [
      ref("AspRunCommand"),
      ref("AspSubscriptionCommand"),
      ref("AspAgentCommand"),
      ref("AspInputCommand"),
      ref("AspStateCommand"),
    ],
  },
  AspMessage: { anyOf: [ref("AspCommandResponse"), ref("AspErrorResponse"), ref("AspEvent")] },
  AspCommandResponse: object(
    {
      type: { const: "success" },
      id: ref("Aspjs_uint"),
      result: ref("AspResultData"),
      meta: ref("AspResponseMeta"),
    },
    ["type", "id", "result"],
    true,
  ),
  AspErrorResponse: object(
    {
      type: { const: "error" },
      id: { anyOf: [ref("Aspjs_uint"), { type: "null" }] },
      error: ref("AspErrorCode"),
      message: { type: "string" },
      stacktrace: { type: "string" },
      meta: ref("AspResponseMeta"),
    },
    ["type", "id", "error", "message"],
    true,
  ),
  AspEvent: {
    anyOf: [
      object(
        {
          type: { const: "event" },
          eventId: { type: "string" },
          seq: ref("Aspjs_uint"),
          method: { const: "lifecycle" },
          params: object(
            {
              namespace: ref("AspNamespace"),
              timestamp: ref("AspTimestamp"),
              data: ref("AspLifecycleData"),
            },
            ["namespace", "timestamp", "data"],
            false,
          ),
        },
        ["type", "method", "params"],
        true,
      ),
      object(
        {
          type: { const: "event" },
          eventId: { type: "string" },
          seq: ref("Aspjs_uint"),
          method: { const: "messages" },
          params: object(
            {
              namespace: ref("AspNamespace"),
              timestamp: ref("AspTimestamp"),
              node: { type: "string" },
              data: ref("AspMessagesData"),
            },
            ["namespace", "timestamp", "data"],
            false,
          ),
        },
        ["type", "method", "params"],
        true,
      ),
      object(
        {
          type: { const: "event" },
          eventId: { type: "string" },
          seq: ref("Aspjs_uint"),
          method: { const: "tools" },
          params: object(
            {
              namespace: ref("AspNamespace"),
              timestamp: ref("AspTimestamp"),
              node: { type: "string" },
              data: ref("AspToolsData"),
            },
            ["namespace", "timestamp", "data"],
            false,
          ),
        },
        ["type", "method", "params"],
        true,
      ),
      object(
        {
          type: { const: "event" },
          eventId: { type: "string" },
          seq: ref("Aspjs_uint"),
          method: { const: "input.requested" },
          params: object(
            {
              namespace: ref("AspNamespace"),
              timestamp: ref("AspTimestamp"),
              data: ref("AspInputRequestedData"),
            },
            ["namespace", "timestamp", "data"],
            false,
          ),
        },
        ["type", "method", "params"],
        true,
      ),
      object(
        {
          type: { const: "event" },
          eventId: { type: "string" },
          seq: ref("Aspjs_uint"),
          method: { const: "values" },
          params: object(
            { namespace: ref("AspNamespace"), timestamp: ref("AspTimestamp"), data: {} },
            ["namespace", "timestamp", "data"],
            false,
          ),
        },
        ["type", "method", "params"],
        true,
      ),
      object(
        {
          type: { const: "event" },
          eventId: { type: "string" },
          seq: ref("Aspjs_uint"),
          method: { const: "updates" },
          params: object(
            {
              namespace: ref("AspNamespace"),
              timestamp: ref("AspTimestamp"),
              data: ref("AspUpdatesData"),
            },
            ["namespace", "timestamp", "data"],
            false,
          ),
        },
        ["type", "method", "params"],
        true,
      ),
      object(
        {
          type: { const: "event" },
          eventId: { type: "string" },
          seq: ref("Aspjs_uint"),
          method: { const: "checkpoints" },
          params: object(
            {
              namespace: ref("AspNamespace"),
              timestamp: ref("AspTimestamp"),
              data: ref("AspCheckpoint"),
            },
            ["namespace", "timestamp", "data"],
            false,
          ),
        },
        ["type", "method", "params"],
        true,
      ),
      object(
        {
          type: { const: "event" },
          eventId: { type: "string" },
          seq: ref("Aspjs_uint"),
          method: { const: "custom" },
          params: object(
            {
              namespace: ref("AspNamespace"),
              timestamp: ref("AspTimestamp"),
              data: ref("AspCustomData"),
            },
            ["namespace", "timestamp", "data"],
            false,
          ),
        },
        ["type", "method", "params"],
        true,
      ),
      object(
        {
          type: { const: "event" },
          eventId: { type: "string" },
          seq: ref("Aspjs_uint"),
          method: { const: "tasks" },
          params: object(
            { namespace: ref("AspNamespace"), timestamp: ref("AspTimestamp"), data: {} },
            ["namespace", "timestamp", "data"],
            false,
          ),
        },
        ["type", "method", "params"],
        true,
      ),
    ],
  },
  AspResultData: {
    anyOf: [
      ref("AspRunResult"),
      ref("AspSubscriptionResult"),
      ref("AspAgentResult"),
      ref("AspInputResult"),
      ref("AspStateResult"),
      ref("AspEmptyResult"),
    ],
  },
  AspEmptyResult: object({}, [], true),
  AspErrorCode: {
    anyOf: [
      { const: "invalid_argument" },
      { const: "unknown_command" },
      { const: "unknown_error" },
      { const: "no_such_run" },
      { const: "no_such_subscription" },
      { const: "no_such_namespace" },
      { const: "no_such_interrupt" },
      { const: "no_such_checkpoint" },
      { const: "permission_denied" },
      { const: "not_supported" },
    ],
  },
  AspResponseMeta: object({ appliedThroughSeq: ref("Aspjs_uint") }, [], true),
  AspRunCommand: ref("Asprun_start"),
  Asprun_start: object(
    { method: { const: "run.start" }, params: ref("AspRunStartParams") },
    ["method", "params"],
    false,
  ),
  AspLangSmithTracer: object(
    { projectName: { type: "string" }, exampleId: { type: "string" } },
    [],
    false,
  ),
  AspRunStartParams: object(
    {
      assistantId: { type: "string" },
      input: {},
      config: object({}, [], {}),
      metadata: object({}, [], {}),
      langsmithTracer: ref("AspLangSmithTracer"),
    },
    ["assistantId", "input"],
    false,
  ),
  AspRunResult: object({ runId: { type: "string" } }, [], false),
  AspChannel: {
    anyOf: [
      { const: "values" },
      { const: "updates" },
      { const: "messages" },
      { const: "tools" },
      { const: "lifecycle" },
      { const: "input" },
      { const: "checkpoints" },
      { const: "tasks" },
      { const: "custom" },
      { type: "string", pattern: "custom:.+" },
    ],
  },
  AspEventStreamRequest: object(
    {
      channels: { type: "array", items: ref("AspChannel"), minItems: 1 },
      namespaces: { type: "array", items: ref("AspNamespace") },
      depth: { type: "integer", minimum: 0 },
      since: ref("Aspjs_uint"),
    },
    ["channels"],
    true,
  ),
  AspSubscriptionCommand: {
    anyOf: [
      ref("Aspsubscription_subscribe"),
      ref("Aspsubscription_unsubscribe"),
      ref("Aspsubscription_reconnect"),
    ],
  },
  Aspsubscription_subscribe: object(
    { method: { const: "subscription.subscribe" }, params: ref("AspSubscribeParams") },
    ["method", "params"],
    false,
  ),
  AspSubscribeParams: object(
    {
      channels: { type: "array", items: ref("AspChannel"), minItems: 1 },
      namespaces: { type: "array", items: ref("AspNamespace") },
      depth: { type: "integer", minimum: 0 },
    },
    ["channels"],
    true,
  ),
  AspSubscribeResult: object(
    { subscriptionId: { type: "string" }, replayedEvents: { type: "integer", minimum: 0 } },
    ["subscriptionId"],
    true,
  ),
  Aspsubscription_unsubscribe: object(
    { method: { const: "subscription.unsubscribe" }, params: ref("AspUnsubscribeParams") },
    ["method", "params"],
    false,
  ),
  AspUnsubscribeParams: object({ subscriptionId: { type: "string" } }, ["subscriptionId"], true),
  Aspsubscription_reconnect: object(
    { method: { const: "subscription.reconnect" }, params: ref("AspReconnectParams") },
    ["method", "params"],
    false,
  ),
  AspReconnectParams: object(
    {
      runId: { type: "string" },
      lastEventId: { type: "string" },
      subscriptions: { type: "array", items: { type: "string" } },
    },
    ["runId"],
    true,
  ),
  AspReconnectResult: object(
    {
      restored: { type: "boolean" },
      missedEvents: { type: "integer", minimum: 0 },
      currentNamespaces: { type: "array", items: ref("AspAgentStatusEntry") },
    },
    ["restored"],
    true,
  ),
  AspAgentStatusEntry: object(
    { namespace: ref("AspNamespace"), status: ref("AspAgentStatus") },
    ["namespace", "status"],
    true,
  ),
  AspSubscriptionResult: {
    anyOf: [ref("AspSubscribeResult"), ref("AspReconnectResult"), ref("AspEmptyResult")],
  },
  AspAgentCommand: ref("Aspagent_getTree"),
  Aspagent_getTree: object(
    { method: { const: "agent.getTree" }, params: ref("AspAgentGetTreeParams") },
    ["method", "params"],
    false,
  ),
  AspAgentGetTreeParams: object({ runId: { type: "string" } }, [], false),
  AspAgentTreeNode: object(
    {
      namespace: ref("AspNamespace"),
      status: ref("AspAgentStatus"),
      graphName: { type: "string" },
      children: { type: "array", items: ref("AspAgentTreeNode") },
      metadata: object({}, [], {}),
    },
    ["namespace", "status", "graphName"],
    false,
  ),
  AspAgentResult: object({ tree: ref("AspAgentTreeNode") }, ["tree"], false),
  AspAgentStatus: {
    anyOf: [
      { const: "started" },
      { const: "running" },
      { const: "completed" },
      { const: "failed" },
      { const: "interrupted" },
    ],
  },
  AspEventData: {
    anyOf: [
      ref("AspLifecycleEvent"),
      ref("AspMessagesEvent"),
      ref("AspToolsEvent"),
      ref("AspInputEvent"),
      ref("AspValuesEvent"),
      ref("AspUpdatesEvent"),
      ref("AspCheckpointsEvent"),
      ref("AspCustomEvent"),
      ref("AspTasksEvent"),
    ],
  },
  AspLifecycleEvent: object(
    {
      method: { const: "lifecycle" },
      params: object(
        {
          namespace: ref("AspNamespace"),
          timestamp: ref("AspTimestamp"),
          data: ref("AspLifecycleData"),
        },
        ["namespace", "timestamp", "data"],
        false,
      ),
    },
    ["method", "params"],
    false,
  ),
  AspLifecycleCause: {
    anyOf: [
      ref("AspLifecycleCauseToolCall"),
      ref("AspLifecycleCauseSend"),
      ref("AspLifecycleCauseEdge"),
    ],
  },
  AspLifecycleCauseToolCall: object(
    { type: { const: "toolCall" }, toolCallId: { type: "string" } },
    ["type", "toolCallId"],
    false,
  ),
  AspLifecycleCauseSend: object(
    { type: { const: "send" }, fromNode: { type: "string" } },
    ["type", "fromNode"],
    false,
  ),
  AspLifecycleCauseEdge: object(
    { type: { const: "edge" }, fromNode: { type: "string" } },
    ["type", "fromNode"],
    false,
  ),
  AspLifecycleData: object(
    {
      event: ref("AspAgentStatus"),
      graphName: { type: "string" },
      cause: ref("AspLifecycleCause"),
      error: { type: "string" },
      checkpoint: ref("AspCheckpointRef"),
    },
    ["event"],
    false,
  ),
  AspMessagesEvent: object(
    {
      method: { const: "messages" },
      params: object(
        {
          namespace: ref("AspNamespace"),
          timestamp: ref("AspTimestamp"),
          node: { type: "string" },
          data: ref("AspMessagesData"),
        },
        ["namespace", "timestamp", "data"],
        false,
      ),
    },
    ["method", "params"],
    false,
  ),
  AspMessagesData: {
    anyOf: [
      ref("AspMessageStartData"),
      ref("AspContentBlockStartData"),
      ref("AspContentBlockDeltaData"),
      ref("AspContentBlockFinishData"),
      ref("AspMessageFinishData"),
      ref("AspMessageErrorData"),
    ],
  },
  AspMessageStartData: object(
    {
      event: { const: "message-start" },
      role: ref("AspMessageRole"),
      id: { type: "string" },
      metadata: ref("AspMessageMetadata"),
    },
    ["event", "role", "id"],
    true,
  ),
  AspContentBlockStartData: object(
    {
      event: { const: "content-block-start" },
      index: { type: "integer", minimum: 0 },
      content: ref("AspContentBlock"),
    },
    ["event", "index", "content"],
    true,
  ),
  AspContentBlockDeltaData: object(
    {
      event: { const: "content-block-delta" },
      index: { type: "integer", minimum: 0 },
      delta: ref("AspContentBlockDelta"),
    },
    ["event", "index", "delta"],
    true,
  ),
  AspContentBlockFinishData: object(
    {
      event: { const: "content-block-finish" },
      index: { type: "integer", minimum: 0 },
      content: ref("AspFinalizedContentBlock"),
    },
    ["event", "index", "content"],
    true,
  ),
  AspMessageFinishData: object(
    { event: { const: "message-finish" }, usage: ref("AspUsageInfo") },
    ["event"],
    true,
  ),
  AspInputTokenDetails: object(
    {
      audio: { type: "integer", minimum: 0 },
      cacheCreation: { type: "integer", minimum: 0 },
      cacheRead: { type: "integer", minimum: 0 },
    },
    [],
    true,
  ),
  AspOutputTokenDetails: object(
    { audio: { type: "integer", minimum: 0 }, reasoning: { type: "integer", minimum: 0 } },
    [],
    true,
  ),
  AspUsageInfo: object(
    {
      inputTokens: { type: "integer", minimum: 0 },
      outputTokens: { type: "integer", minimum: 0 },
      totalTokens: { type: "integer", minimum: 0 },
      inputTokenDetails: ref("AspInputTokenDetails"),
      outputTokenDetails: ref("AspOutputTokenDetails"),
    },
    [],
    true,
  ),
  AspMessageErrorData: object(
    { event: { const: "error" }, message: { type: "string" }, code: { type: "string" } },
    ["event", "message"],
    true,
  ),
  AspToolsEvent: object(
    {
      method: { const: "tools" },
      params: object(
        {
          namespace: ref("AspNamespace"),
          timestamp: ref("AspTimestamp"),
          node: { type: "string" },
          data: ref("AspToolsData"),
        },
        ["namespace", "timestamp", "data"],
        false,
      ),
    },
    ["method", "params"],
    false,
  ),
  AspToolsData: {
    anyOf: [
      ref("AspToolStartedData"),
      ref("AspToolOutputDeltaData"),
      ref("AspToolFinishedData"),
      ref("AspToolErrorData"),
    ],
  },
  AspToolStartedData: object(
    {
      event: { const: "tool-started" },
      toolCallId: { type: "string" },
      toolName: { type: "string" },
      input: {},
    },
    ["event", "toolCallId", "toolName"],
    true,
  ),
  AspToolOutputDeltaData: object(
    {
      event: { const: "tool-output-delta" },
      toolCallId: { type: "string" },
      delta: { type: "string" },
    },
    ["event", "toolCallId", "delta"],
    true,
  ),
  AspToolFinishedData: object(
    { event: { const: "tool-finished" }, toolCallId: { type: "string" }, output: {} },
    ["event", "toolCallId", "output"],
    true,
  ),
  AspToolErrorData: object(
    {
      event: { const: "tool-error" },
      toolCallId: { type: "string" },
      message: { type: "string" },
      code: { type: "string" },
    },
    ["event", "toolCallId", "message"],
    true,
  ),
  AspInputCommand: { anyOf: [ref("Aspinput_respond"), ref("Aspinput_inject")] },
  Aspinput_respond: object(
    { method: { const: "input.respond" }, params: ref("AspInputRespondParams") },
    ["method", "params"],
    false,
  ),
  AspInputRespondParams: { anyOf: [ref("AspInputRespondOne"), ref("AspInputRespondMany")] },
  AspRunSend: object({ node: { type: "string" }, input: {} }, ["node"], false),
  AspGoto: {
    anyOf: [
      { type: "string" },
      ref("AspRunSend"),
      { type: "array", items: { anyOf: [{ type: "string" }, ref("AspRunSend")] } },
    ],
  },
  AspInputRespondOne: object(
    {
      namespace: ref("AspNamespace"),
      interruptId: { type: "string" },
      response: {},
      update: object({}, [], {}),
      goto: ref("AspGoto"),
      config: object({}, [], {}),
      metadata: object({}, [], {}),
    },
    ["namespace", "interruptId", "response"],
    false,
  ),
  AspInputRespondMany: object(
    {
      responses: { type: "array", items: ref("AspInputRespondEntry"), minItems: 1 },
      update: object({}, [], {}),
      goto: ref("AspGoto"),
      config: object({}, [], {}),
      metadata: object({}, [], {}),
    },
    ["responses"],
    false,
  ),
  AspInputRespondEntry: object(
    { namespace: ref("AspNamespace"), interruptId: { type: "string" }, response: {} },
    ["namespace", "interruptId", "response"],
    false,
  ),
  Aspinput_inject: object(
    { method: { const: "input.inject" }, params: ref("AspInputInjectParams") },
    ["method", "params"],
    false,
  ),
  AspInputInjectParams: object(
    { namespace: ref("AspNamespace"), message: ref("AspInputMessage") },
    ["namespace", "message"],
    false,
  ),
  AspInputMessage: object(
    {
      role: { anyOf: [{ const: "user" }, { const: "system" }] },
      content: { type: "string" },
      name: { type: "string" },
    },
    ["role", "content"],
    true,
  ),
  AspInputResult: ref("AspEmptyResult"),
  AspInputEvent: object(
    {
      method: { const: "input.requested" },
      params: object(
        {
          namespace: ref("AspNamespace"),
          timestamp: ref("AspTimestamp"),
          data: ref("AspInputRequestedData"),
        },
        ["namespace", "timestamp", "data"],
        false,
      ),
    },
    ["method", "params"],
    false,
  ),
  AspInputRequestedData: object(
    { interruptId: { type: "string" }, payload: {} },
    ["interruptId", "payload"],
    true,
  ),
  AspStateCommand: {
    anyOf: [ref("Aspstate_get"), ref("Aspstate_listCheckpoints"), ref("Aspstate_fork")],
  },
  Aspstate_get: object(
    { method: { const: "state.get" }, params: ref("AspStateGetParams") },
    ["method", "params"],
    false,
  ),
  AspStateGetParams: object(
    { namespace: ref("AspNamespace"), keys: { type: "array", items: { type: "string" } } },
    ["namespace"],
    false,
  ),
  AspStateGetResult: object(
    { values: object({}, [], {}), checkpoint: ref("AspCheckpointRef") },
    ["values"],
    false,
  ),
  Aspstate_listCheckpoints: object(
    { method: { const: "state.listCheckpoints" }, params: ref("AspListCheckpointsParams") },
    ["method", "params"],
    false,
  ),
  AspListCheckpointsParams: object(
    {
      namespace: ref("AspNamespace"),
      limit: { type: "integer", minimum: 0 },
      before: { type: "string" },
    },
    [],
    false,
  ),
  AspListCheckpointsResult: object(
    { checkpoints: { type: "array", items: ref("AspCheckpointSummary") } },
    ["checkpoints"],
    false,
  ),
  AspCheckpointSummary: object(
    {
      id: { type: "string" },
      timestamp: { type: "string" },
      step: { type: "integer", minimum: 0 },
      nodeName: { type: "string" },
      metadata: object({}, [], {}),
    },
    ["id", "timestamp", "step"],
    false,
  ),
  AspCheckpointRef: object({ id: { type: "string" }, ns: { type: "string" } }, ["id"], false),
  Aspstate_fork: object(
    { method: { const: "state.fork" }, params: ref("AspStateForkParams") },
    ["method", "params"],
    false,
  ),
  AspStateForkParams: object(
    { checkpointId: { type: "string" }, input: {}, config: object({}, [], {}) },
    ["checkpointId"],
    false,
  ),
  AspStateForkResult: object(
    { runId: { type: "string" }, threadId: { type: "string" } },
    ["runId", "threadId"],
    false,
  ),
  AspStateResult: {
    anyOf: [
      ref("AspStateGetResult"),
      ref("AspListCheckpointsResult"),
      ref("AspStateForkResult"),
      ref("AspEmptyResult"),
    ],
  },
  AspValuesEvent: object(
    {
      method: { const: "values" },
      params: object(
        { namespace: ref("AspNamespace"), timestamp: ref("AspTimestamp"), data: {} },
        ["namespace", "timestamp", "data"],
        false,
      ),
    },
    ["method", "params"],
    false,
  ),
  AspCheckpointsEvent: object(
    {
      method: { const: "checkpoints" },
      params: object(
        {
          namespace: ref("AspNamespace"),
          timestamp: ref("AspTimestamp"),
          data: ref("AspCheckpoint"),
        },
        ["namespace", "timestamp", "data"],
        false,
      ),
    },
    ["method", "params"],
    false,
  ),
  AspCheckpoint: object(
    {
      id: { type: "string" },
      parentId: { type: "string" },
      step: { type: "integer" },
      source: ref("AspCheckpointSource"),
    },
    ["id", "step", "source"],
    true,
  ),
  AspCheckpointSource: {
    anyOf: [{ const: "input" }, { const: "loop" }, { const: "update" }, { const: "fork" }],
  },
  AspUpdatesEvent: object(
    {
      method: { const: "updates" },
      params: object(
        {
          namespace: ref("AspNamespace"),
          timestamp: ref("AspTimestamp"),
          data: ref("AspUpdatesData"),
        },
        ["namespace", "timestamp", "data"],
        false,
      ),
    },
    ["method", "params"],
    false,
  ),
  AspUpdatesData: object(
    { node: { type: "string" }, values: object({}, [], {}) },
    ["values"],
    true,
  ),
  AspCustomEvent: object(
    {
      method: { const: "custom" },
      params: object(
        {
          namespace: ref("AspNamespace"),
          timestamp: ref("AspTimestamp"),
          data: ref("AspCustomData"),
        },
        ["namespace", "timestamp", "data"],
        false,
      ),
    },
    ["method", "params"],
    false,
  ),
  AspCustomData: object({ name: { type: "string" }, payload: {} }, ["payload"], true),
  AspTasksEvent: object(
    {
      method: { const: "tasks" },
      params: object(
        { namespace: ref("AspNamespace"), timestamp: ref("AspTimestamp"), data: {} },
        ["namespace", "timestamp", "data"],
        false,
      ),
    },
    ["method", "params"],
    false,
  ),
  NativeAgentCapabilities: {
    type: "object",
    properties: {
      identity: ref("NativeIdentityCapabilities"),
      transport: ref("NativeTransportCapabilities"),
      tools: ref("NativeToolsCapabilities"),
      output: ref("NativeOutputCapabilities"),
      state: ref("NativeStateCapabilities"),
      multiAgent: ref("NativeMultiAgentCapabilities"),
      reasoning: ref("NativeReasoningCapabilities"),
      multimodal: ref("NativeMultimodalCapabilities"),
      execution: ref("NativeExecutionCapabilities"),
      humanInTheLoop: ref("NativeHumanInTheLoopCapabilities"),
      custom: object({}, [], true),
    },
    unevaluatedProperties: false,
  },
  NativeIdentityCapabilities: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      type: { type: "string" },
      version: { type: "string" },
      provider: { type: "string" },
      documentationUrl: { type: "string" },
      metadata: ref("NativeMetadata"),
    },
    unevaluatedProperties: false,
  },
  NativeMetadata: object({}, [], true),
  NativeTransportCapabilities: {
    type: "object",
    properties: {
      streaming: { type: "boolean" },
      websocket: { type: "boolean" },
      httpBinary: { type: "boolean" },
      pushNotifications: { type: "boolean" },
      resumable: { type: "boolean" },
    },
    unevaluatedProperties: false,
  },
  NativeToolsCapabilities: {
    type: "object",
    properties: {
      supported: { type: "boolean" },
      items: { type: "array", items: ref("NativeTool") },
      parallelCalls: { type: "boolean" },
      clientProvided: { type: "boolean" },
    },
    unevaluatedProperties: false,
  },
  NativeTool: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      parameters: { not: { type: "null" } },
      metadata: ref("NativeMetadata"),
    },
    required: ["name", "description"],
    unevaluatedProperties: false,
  },
  NativeOutputCapabilities: {
    type: "object",
    properties: {
      structuredOutput: { type: "boolean" },
      supportedMimeTypes: { type: "array", items: { type: "string" } },
    },
    unevaluatedProperties: false,
  },
  NativeStateCapabilities: {
    type: "object",
    properties: {
      snapshots: { type: "boolean" },
      deltas: { type: "boolean" },
      memory: { type: "boolean" },
      persistentState: { type: "boolean" },
    },
    unevaluatedProperties: false,
  },
  NativeMultiAgentCapabilities: {
    type: "object",
    properties: {
      supported: { type: "boolean" },
      delegation: { type: "boolean" },
      handoffs: { type: "boolean" },
      subagents: { type: "array", items: ref("NativeSubagentInfo") },
    },
    unevaluatedProperties: false,
  },
  NativeSubagentInfo: {
    type: "object",
    properties: { name: { type: "string" }, description: { type: "string" } },
    required: ["name"],
    unevaluatedProperties: false,
  },
  NativeReasoningCapabilities: {
    type: "object",
    properties: {
      supported: { type: "boolean" },
      streaming: { type: "boolean" },
      encrypted: { type: "boolean" },
    },
    unevaluatedProperties: false,
  },
  NativeMultimodalCapabilities: {
    type: "object",
    properties: {
      input: ref("NativeMultimodalInputCapabilities"),
      output: ref("NativeMultimodalOutputCapabilities"),
    },
    unevaluatedProperties: false,
  },
  NativeMultimodalInputCapabilities: {
    type: "object",
    properties: {
      image: { type: "boolean" },
      audio: { type: "boolean" },
      video: { type: "boolean" },
      pdf: { type: "boolean" },
      file: { type: "boolean" },
    },
    unevaluatedProperties: false,
  },
  NativeMultimodalOutputCapabilities: {
    type: "object",
    properties: { image: { type: "boolean" }, audio: { type: "boolean" } },
    unevaluatedProperties: false,
  },
  NativeExecutionCapabilities: {
    type: "object",
    properties: {
      codeExecution: { type: "boolean" },
      sandboxed: { type: "boolean" },
      maxIterations: { type: "integer", minimum: 0, maximum: 9007199254740991 },
      maxExecutionTime: { type: "integer", minimum: 0, maximum: 9007199254740991 },
    },
    unevaluatedProperties: false,
  },
  NativeHumanInTheLoopCapabilities: {
    type: "object",
    properties: {
      supported: { type: "boolean" },
      approvals: { type: "boolean" },
      interventions: { type: "boolean" },
      feedback: { type: "boolean" },
      interrupts: { type: "boolean" },
      approveWithEdits: { type: "boolean" },
    },
    unevaluatedProperties: false,
  },
  B4AgentCapabilities: object({
    "ap.io.messages": boolean,
    "ap.io.streaming": boolean,
    "run.b4.protocol": ref("CapabilityProtocolV1"),
    "run.b4.recovery": ref("CapabilityRecoveryV1"),
    "run.b4.permissions": ref("CapabilityPermissionsV1"),
    "run.b4.controls": ref("CapabilityControlsV1"),
    "run.b4.agui": ref("CapabilityAguiV1"),
    "run.b4.workspace": ref("CapabilityWorkspaceV1"),
    "run.b4.store": ref("CapabilityStoreV1"),
  }),
  B4ThreadCreate: {
    allOf: [
      ref("ThreadCreate"),
      object({
        metadata: ref("CallerThreadMetadata"),
        thread_id: uuid,
        workspace: ref("WorkspaceCreate"),
      }),
      { not: { anyOf: [{ required: ["route"] }, { required: ["resume"] }] } },
    ],
  },
  B4ThreadPatch: {
    allOf: [
      ref("ThreadPatch"),
      object({
        metadata: ref("CallerThreadMetadata"),
        messages: array(ref("B4Message")),
        checkpoint: object({ checkpoint_id: uuid }),
      }),
    ],
  },
  B4RunStream: { allOf: [ref("RunStream"), ref("B4RunCreate")] },
  B4RunSearchRequest: {
    allOf: [
      ref("RunSearchRequest"),
      object({
        thread_id: uuid,
        metadata: {
          allOf: [
            { type: "object" },
            {
              if: {
                anyOf: [
                  { required: ["b4.submissionId"] },
                  { required: ["b4.submissionKind"] },
                  { required: ["b4.operationThreadId"] },
                  { required: ["b4.targetRunId"] },
                ],
              },
              // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
              then: ref("OperationLookupSelectors"),
            },
          ],
        },
      }),
    ],
  },
  B4RunCreate: {
    allOf: [
      ref("RunCreate"),
      object({
        metadata: ref("CallerRunMetadata"),
        thread_id: uuid,
        messages: array(ref("B4Message")),
      }),
      { not: { anyOf: [{ required: ["route"] }, { required: ["resume"] }] } },
    ],
  },
  B4Run: {
    allOf: [
      ref("Run"),
      object({
        run_id: uuid,
        created_at: date,
        updated_at: date,
        messages: array(ref("B4Message")),
        thread_id: uuid,
        metadata: object({ b4: ref("RunMetadataV1") }, ["b4"]),
      }),
    ],
  },
  B4Thread: {
    allOf: [
      ref("Thread"),
      object({
        thread_id: uuid,
        created_at: date,
        updated_at: date,
        messages: array(ref("B4Message")),
        metadata: object({ b4: ref("RecoveryV1") }, ["b4"]),
      }),
    ],
  },
  B4ThreadState: {
    allOf: [
      ref("ThreadState"),
      object(
        {
          metadata: object({ b4: ref("HistoryMetadataV1") }, ["b4"]),
          messages: array(ref("B4Message")),
          checkpoint: object({ checkpoint_id: uuid }),
        },
        ["metadata"],
      ),
    ],
  },
  B4Agent: {
    allOf: [
      advertises(
        atPath(["capabilities", "run.b4.controls", "injection"], { const: true }),
        ["injectionInput"],
        ["inbox"],
      ),
      advertises(
        atPath(["capabilities", "run.b4.controls", "stateEdit"], { const: true }),
        ["stateEdit"],
        [],
      ),
      ...["update", "goto", "config"].map((control) =>
        advertises(
          atPath(["capabilities", "run.b4.controls", "resume", control], { const: true }),
          [
            { update: "resumeUpdate", goto: "resumeGoto", config: "resumeConfig" }[
              control
            ] as string,
          ],
          [],
        ),
      ),
      advertises(
        {
          anyOf: [
            atPath(["capabilities", "run.b4.protocol", "transports", "sse"], { const: true }),
            atPath(["capabilities", "run.b4.protocol", "transports", "websocket"], { const: true }),
          ],
        },
        [],
        ["viewer"],
      ),
      advertises(
        atPath(["capabilities", "run.b4.workspace", "inspect"], { const: true }),
        [],
        ["inspection"],
      ),
      advertises(
        atPath(["capabilities", "run.b4.workspace", "staging"], { const: true }),
        [],
        ["staging"],
      ),
      advertises(atPath(["capabilities", "run.b4.recovery"], {}), ["recovery"], []),
      ref("Agent"),
      object(
        {
          metadata: object({ b4: ref("AgentMetadataV1") }, ["b4"]),
          capabilities: ref("B4AgentCapabilities"),
        },
        ["metadata"],
      ),
    ],
  },
  B4Command: {
    allOf: [
      {
        if: { properties: { method: { enum: ["agent.getTree", "subscription.reconnect"] } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
        then: { properties: { params: object({ runId: uuid }) } },
      },
      ref("AspCommand"),
      {
        if: { properties: { method: { enum: ["run.start", "input.respond"] } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
        then: { properties: { params: object({ metadata: ref("CallerRunMetadata") }) } },
      },
      {
        if: { properties: { method: { const: "input.inject" } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
        then: {
          properties: { params: object({ message: object({ b4: ref("RequestMetadataV1") }) }) },
        },
      },
      {
        if: { properties: { method: { const: "state.fork" } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
        then: {
          properties: { b4: ref("RequestMetadataV1"), params: object({ checkpointId: uuid }) },
        },
        else: { properties: { b4: false } },
      },
    ],
  },
  B4ResponseMeta: {
    allOf: [
      ref("AspResponseMeta"),
      object({
        b4: {
          anyOf: [ref("ReceiptResponseMetaV1"), ref("ResyncRequiredV1"), ref("B4DiagnosticV1")],
        },
      }),
    ],
  },
  RunStartResponse: object(
    {
      type: { const: "success" },
      id: uint,
      result: ref("B4RunResult"),
      meta: ref("B4ResponseMeta"),
    },
    ["type", "id", "result"],
  ),
  StateForkResponse: object(
    {
      type: { const: "success" },
      id: uint,
      result: ref("B4StateForkResult"),
      meta: ref("B4ResponseMeta"),
    },
    ["type", "id", "result"],
  ),
  B4CustomData: {
    anyOf: [
      object({ name: { const: "b4.input" }, payload: ref("InputDispositionV1") }, [
        "name",
        "payload",
      ]),
      object(
        {
          name: { const: "b4.run" },
          payload: { allOf: [ref("RunSummary"), object({ v }, ["v"])] },
        },
        ["name", "payload"],
      ),
      object(
        {
          name: { const: "b4.turn" },
          payload: { allOf: [ref("TurnSummary"), object({ v }, ["v"])] },
        },
        ["name", "payload"],
      ),
      object(
        {
          name: { const: "b4.activity" },
          payload: { allOf: [ref("Activity"), object({ v }, ["v"])] },
        },
        ["name", "payload"],
      ),
      object(
        {
          name: { const: "b4.history" },
          payload: object(
            {
              v,
              revision: string,
              reason: enumeration("rollback", "state_edit"),
              removedRunIds: array(uuid),
            },
            ["v", "revision", "reason", "removedRunIds"],
          ),
        },
        ["name", "payload"],
      ),
    ],
  },
  // Inline OpenAPI request/query schemas, retained without invented upstream bounds.
  AgentSearchRequest: object({
    name: string,
    metadata: { type: "object" },
    limit: { type: "integer", minimum: 1, maximum: 1000, default: 10 },
    offset: { type: "integer", minimum: 0, default: 0 },
  }),
  ThreadHistoryQuery: object({ limit: { type: "integer", default: 10 }, before: string }),
  B4ThreadHistoryQuery: object({
    limit: { type: "integer", maximum: 1000, default: 10 },
    before: string,
  }),
  RunCancelQuery: object({
    action: { type: "string", enum: ["interrupt", "rollback"], default: "interrupt" },
    wait: { type: "boolean", default: false },
  }),
  StoreGetQuery: object({ namespace, key: string }, ["key"]),
  B4RunResult: object({ runId: uuid }, ["runId"], false),
  B4StateForkResult: object({ runId: uuid, threadId: uuid }, ["runId", "threadId"], false),
  B4Message: {
    allOf: [ref("Message"), object({ role: enumeration("user", "assistant", "system", "tool") })],
  },
  RunStreamMetadata: object({ run: ref("B4Run") }, ["run"]),
  RunStreamUpdates: object({ namespace, node: string, values: { type: "object" } }, [
    "namespace",
    "values",
  ]),
  RunStreamCustom: object({ namespace, name: string, payload: {} }, ["namespace", "payload"]),
  B4DiagnosticV1: object({ v, code: string }, ["v", "code"]),
  InputDispositionV1: object(
    {
      v,
      inputId: uuid,
      runId: uuid,
      turnId: uuid,
      disposition,
      reason: string,
      grant: false,
      submissionId: false,
      receipt: false,
      message: false,
    },
    ["v", "inputId", "runId", "turnId", "disposition"],
  ),
  WebhookDeliverySummary: object(
    {
      state: enumeration("pending", "delivered", "failed"),
      attempts: { type: "integer", minimum: 0, maximum: 5 },
    },
    ["state", "attempts"],
    false,
  ),
  AgentSchemasV1: object({
    injectionInput: { type: "object" },
    stateEdit: { type: "object" },
    resumeUpdate: { type: "object" },
    resumeGoto: { type: "object" },
    resumeConfig: { type: "object" },
    recovery: { type: "object" },
    custom: { type: "object", additionalProperties: { type: "object" } },
  }),
  AgentInspectionBounds: object({ maxEntries: uint, maxFileBytes: uint, maxTotalBytes: uint }, [
    "maxEntries",
    "maxFileBytes",
    "maxTotalBytes",
  ]),
  AgentLimitsV1: object(
    {
      requestBytes: uint,
      pendingPrompts: uint,
      snapshotBytes: uint,
      eventBytes: uint,
      inbox: object({ entries: uint, bytes: uint, textBytes: uint }, [
        "entries",
        "bytes",
        "textBytes",
      ]),
      viewer: object({ events: uint, bytes: uint }, ["events", "bytes"]),
      inspection: object(
        {
          requestBytes: uint,
          responseBytes: uint,
          defaults: ref("AgentInspectionBounds"),
          caps: ref("AgentInspectionBounds"),
        },
        ["requestBytes", "responseBytes", "defaults", "caps"],
      ),
      staging: object({ uploadBytes: uint, quotaBytes: uint, deadlineMs: uint }, [
        "uploadBytes",
        "quotaBytes",
        "deadlineMs",
      ]),
    },
    ["requestBytes", "pendingPrompts"],
  ),
  B4CheckpointRef: { allOf: [ref("AspCheckpointRef"), object({ id: uuid })] },
  B4Checkpoint: { allOf: [ref("AspCheckpoint"), object({ id: uuid, parentId: uuid })] },
  B4StateGetResult: {
    allOf: [ref("AspStateGetResult"), object({ checkpoint: ref("B4CheckpointRef") })],
  },
  B4RunWaitResponse: {
    allOf: [
      ref("RunWaitResponse"),
      object({ run: ref("B4Run"), messages: array(ref("B4Message")) }),
    ],
  },
  CanonicalId: uuid,
  RequestMetadataV1: object(
    {
      v,
      submissionId: uuid,
      expected: object({ generation: uuid, runId: uuid, pausedGeneration: uuid }, [], false),
    },
    ["v"],
    false,
  ),
  CallerThreadMetadata: {
    type: "object",
    propertyNames: { allOf: [reservedSelectors, { not: { const: "b4" } }] },
  },
  CallerRunMetadata: {
    type: "object",
    propertyNames: reservedSelectors,
    properties: { b4: ref("RequestMetadataV1") },
  },
  OperationLookupSelectors: {
    allOf: [
      object(
        {
          "b4.submissionId": string,
          "b4.submissionKind": enumeration("b4", "agui"),
          "b4.operationThreadId": uuid,
          "b4.targetRunId": uuid,
        },
        ["b4.submissionId", "b4.submissionKind"],
      ),
      {
        if: { properties: { "b4.submissionKind": { const: "b4" } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
        then: { properties: { "b4.submissionId": uuid } },
      },
    ],
  },
  ReceiptV1: {
    allOf: [
      object(
        {
          submissionId: string,
          submissionKind: enumeration("b4", "agui"),
          runId: uuid,
          turnId: uuid,
          acceptedAt: date,
          replayed: boolean,
          disposition,
          inputId: uuid,
          reason: string,
        },
        [
          "submissionId",
          "submissionKind",
          "runId",
          "turnId",
          "acceptedAt",
          "replayed",
          "disposition",
        ],
      ),
      token,
    ],
  },
  OperationLookupV1: {
    allOf: [
      object(
        {
          submissionId: string,
          submissionKind: enumeration("b4", "agui"),
          state: enumeration("accepted", "expired"),
          receipt: ref("ReceiptV1"),
        },
        ["submissionId", "submissionKind", "state"],
      ),
      token,
      {
        if: { properties: { state: { const: "accepted" } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
        then: { required: ["receipt"] },
        else: { not: { required: ["receipt"] } },
      },
    ],
  },
  ReceiptResponseMetaV1: object({ v, receipt: ref("ReceiptV1") }, ["v", "receipt"]),
  InputReceiptResultV1: object({ runId: uuid, b4: ref("ReceiptResponseMetaV1") }, ["runId", "b4"]),
  RunMetadataV1: {
    allOf: [
      object(
        {
          v,
          generation: uuid,
          turnId: uuid,
          previousRunId: uuid,
          phase,
          reason: runReason,
          continuation,
          submissionId: string,
          acceptedAt: date,
          startedAt: date,
          settledAt: date,
          effectsUncertain: boolean,
          submissionKind: enumeration("b4", "agui"),
          lookup: ref("OperationLookupV1"),
          webhook: ref("WebhookDeliverySummary"),
        },
        ["v", "generation", "turnId", "phase", "continuation", "acceptedAt", "effectsUncertain"],
      ),
      {
        if: { properties: { submissionKind: { const: "agui" } }, required: ["submissionKind"] },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
        then: {},
        else: { properties: { submissionId: uuid } },
      },
    ],
  },
  RunSummary: object(
    {
      runId: uuid,
      turnId: uuid,
      agentId: string,
      status: enumeration("pending", "success", "interrupted", "timeout", "error"),
      phase,
      continuation,
      effectsUncertain: boolean,
      previousRunId: uuid,
      reason: runReason,
    },
    ["runId", "turnId", "agentId", "status", "phase", "continuation", "effectsUncertain"],
  ),
  TurnSummary: object(
    {
      turnId: uuid,
      currentRunId: uuid,
      state: enumeration("running", "waiting", "completed", "stopped", "error", "timeout"),
      continuation,
      reason: runReason,
    },
    ["turnId", "currentRunId", "state", "continuation"],
  ),
  PermissionResponseV1: object(
    { decision: enumeration("once", "always", "deny"), grant: string },
    ["decision"],
    false,
  ),
  PermissionPayloadV1: object(
    {
      type: { const: "b4.permission" },
      v,
      request: { type: "object" },
      responseSchema: { type: "object" },
      allowedDecisions: { type: "array", items: enumeration("once", "always", "deny") },
      allowAlways: boolean,
    },
    ["type", "v", "request", "responseSchema", "allowedDecisions", "allowAlways"],
  ),
  PendingMetadataV1: object(
    {
      v,
      pausedGeneration: uuid,
      proposalHash: string,
      status: enumeration("waiting", "expired", "resolved", "denied", "abandoned", "stopped"),
      expiresAt: date,
      grant: string,
      responseSchema: { type: "object" },
    },
    ["v", "pausedGeneration", "proposalHash", "status"],
  ),
  PendingInput: object(
    {
      namespace,
      runId: uuid,
      turnId: uuid,
      data: {
        allOf: [ref("AspInputRequestedData"), object({ b4: ref("PendingMetadataV1") }, ["b4"])],
      },
    },
    ["namespace", "runId", "turnId", "data"],
  ),
  RecoveryCheckpoint: object({ checkpoint_id: uuid, namespace, parent_checkpoint_id: uuid }, [
    "checkpoint_id",
    "namespace",
  ]),
  HistoryLineage: object(
    {
      checkpointId: uuid,
      namespace,
      fragmentIndex: uint,
      parentCheckpointId: uuid,
      sourceThreadId: uuid,
      sourceCheckpointId: uuid,
      originRunId: uuid,
    },
    ["checkpointId", "namespace", "fragmentIndex"],
  ),
  HistoryCoverage: object(
    { anchor: { type: "string", minLength: 1 }, nextBefore: nullable(string), complete: boolean },
    ["anchor", "nextBefore", "complete"],
  ),
  Activity: {
    allOf: [
      object(
        {
          id: string,
          namespace,
          runId: uuid,
          turnId: uuid,
          type: string,
          payload: {},
          state: enumeration(
            "open",
            "completed",
            "interrupted",
            "failed",
            "denied",
            "cancelled",
            "historical",
          ),
          sourceSeq: uint,
          effectsUncertain: boolean,
        },
        ["id", "namespace", "turnId", "type", "payload", "state", "sourceSeq", "effectsUncertain"],
      ),
      {
        if: { properties: { state: { const: "historical" } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
        then: {},
        else: { required: ["runId"] },
      },
    ],
  },
  Maintenance: object(
    {
      operationId: uuid,
      type: enumeration("rollback", "delete"),
      state: enumeration("requested", "draining", "cleaning", "failed"),
      targetRunId: uuid,
    },
    ["operationId", "type", "state"],
  ),
  Retention: object(
    {
      replaySeconds: uint,
      replayBytes: uint,
      oldestSeq: uint,
      latestSeq: uint,
      receiptSecondsAfterSettlement: uint,
      resultExpiresAt: date,
    },
    ["replaySeconds", "replayBytes", "oldestSeq", "latestSeq", "receiptSecondsAfterSettlement"],
  ),
  RecoveryV1: {
    allOf: [
      object(
        {
          v,
          generation: uuid,
          throughSeq: uint,
          eventId: nullable({
            type: "string",
            pattern:
              "^b4e1\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.[1-9][0-9]*$",
          }),
          revision: string,
          checkpoint: ref("RecoveryCheckpoint"),
          history: ref("HistoryCoverage"),
          turn: nullable(ref("TurnSummary")),
          run: nullable(ref("RunSummary")),
          pending: array(ref("PendingInput")),
          activity: array(ref("Activity")),
          maintenance: nullable(ref("Maintenance")),
          retention: ref("Retention"),
        },
        [
          "v",
          "generation",
          "throughSeq",
          "eventId",
          "revision",
          "history",
          "turn",
          "run",
          "pending",
          "activity",
          "maintenance",
          "retention",
        ],
      ),
      {
        if: { properties: { throughSeq: { const: 0 } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
        then: { properties: { eventId: { type: "null" } } },
        else: { properties: { eventId: { type: "string" } } },
      },
    ],
  },
  HistoryMetadataV1: object(
    {
      v,
      generation: uuid,
      revision: string,
      namespace,
      lineage: ref("HistoryLineage"),
      throughSeq: uint,
      history: ref("HistoryCoverage"),
      activity: array(ref("Activity")),
    },
    ["v", "generation", "revision", "namespace", "lineage", "throughSeq", "history", "activity"],
  ),
  EventCorrelationV1: {
    allOf: [
      object({ v, generation: uuid, runId: uuid, turnId: uuid }, ["v", "generation"]),
      { dependentRequired: { runId: ["turnId"], turnId: ["runId"] } },
    ],
  },
  SnapshotDeliveryV1: object(
    { v, generation: uuid, delivery: { const: "snapshot" }, throughSeq: uint },
    ["v", "generation", "delivery", "throughSeq"],
  ),
  ReplayRequestV1: object({ v, generation: uuid }, ["v", "generation"], false),
  ResyncRequiredV1: object(
    { v, code: { const: "resync_required" }, generation: uuid, oldestSeq: uint, latestSeq: uint },
    ["v", "code", "generation", "oldestSeq", "latestSeq"],
  ),
  B4Event: {
    allOf: [
      {
        // Only the five reserved names select B4 contracts; application custom data stays opaque.
        if: {
          allOf: [
            atPath(["method"], { const: "custom" }),
            atPath(
              ["params", "data", "name"],
              enumeration("b4.run", "b4.turn", "b4.input", "b4.activity", "b4.history"),
            ),
          ],
        },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
        then: atPath(["params", "data"], ref("B4CustomData")),
      },
      {
        if: { properties: { method: { const: "checkpoints" } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
        then: { properties: { params: object({ data: ref("B4Checkpoint") }) } },
      },
      {
        if: { properties: { method: { const: "lifecycle" } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
        then: {
          properties: { params: object({ data: object({ checkpoint: ref("B4CheckpointRef") }) }) },
        },
      },
      ref("AspEvent"),
      object(
        {
          b4: ref("EventCorrelationV1"),
          eventId: {
            type: "string",
            pattern:
              "^b4e1\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.[1-9][0-9]*$",
          },
          seq: { type: "integer", minimum: 1, maximum: 9007199254740991 },
        },
        ["b4", "eventId", "seq"],
      ),
    ],
  },
  B4SnapshotEvent: {
    allOf: [
      ref("AspEvent"),
      object({ method: { const: "values" }, b4: ref("SnapshotDeliveryV1") }, ["b4"]),
      { not: { anyOf: [{ required: ["eventId"] }, { required: ["seq"] }] } },
    ],
  },
  B4EventStreamRequest: {
    allOf: [ref("AspEventStreamRequest"), object({ b4: ref("ReplayRequestV1") })],
  },
  B4ErrorResponse: object(
    {
      code: string,
      message: string,
      metadata: {
        type: "object",
        properties: {
          b4: {
            anyOf: [ref("ReceiptResponseMetaV1"), ref("ResyncRequiredV1"), ref("B4DiagnosticV1")],
          },
        },
      },
    },
    ["code", "message"],
  ),
  CapabilityProtocolV1: object(
    {
      v,
      openapi: { const: "0.1.6" },
      cddl: { const: "0.0.20" },
      profile: enumeration("node-sqlite", "node-postgres", "host-reduced"),
      transports: object({ sse: boolean, commands: boolean, websocket: boolean }, [
        "sse",
        "commands",
        "websocket",
      ]),
      backgroundRuns: boolean,
      continueAfterDisconnect: boolean,
      webhooks: boolean,
    },
    [
      "v",
      "openapi",
      "cddl",
      "profile",
      "transports",
      "backgroundRuns",
      "continueAfterDisconnect",
      "webhooks",
    ],
  ),
  CapabilityRecoveryV1: object(
    {
      v,
      threadMetadata: { const: "b4" },
      historyMetadata: { const: "b4" },
      eventEnvelope: { const: "b4" },
      replaySeconds: uint,
      replayBytes: uint,
      resultSecondsAfterTemporaryCleanup: uint,
      receiptSecondsAfterSettlement: uint,
    },
    [
      "v",
      "threadMetadata",
      "historyMetadata",
      "eventEnvelope",
      "replaySeconds",
      "replayBytes",
      "resultSecondsAfterTemporaryCleanup",
      "receiptSecondsAfterSettlement",
    ],
  ),
  CapabilityPermissionsV1: object(
    {
      v,
      completeSet: { const: true },
      decisions: { const: ["once", "always", "deny"] },
      grants: enumeration("off", "optional", "required"),
      allowAlways: boolean,
      responseSchema: { type: "object" },
    },
    ["v", "completeSet", "decisions", "grants", "allowAlways", "responseSchema"],
  ),
  CapabilityControlsV1: object(
    {
      v,
      injection: boolean,
      rollback: boolean,
      stateEdit: boolean,
      copy: boolean,
      fork: boolean,
      forkNamespaces: enumeration("root", "declared"),
      resume: object({ update: boolean, goto: boolean, config: boolean }, [
        "update",
        "goto",
        "config",
      ]),
      systemInjection: boolean,
    },
    [
      "v",
      "injection",
      "rollback",
      "stateEdit",
      "copy",
      "fork",
      "forkNamespaces",
      "resume",
      "systemInjection",
    ],
  ),
  CapabilityAguiV1: object({ v, path: string, capabilities: ref("NativeAgentCapabilities") }, [
    "v",
    "path",
    "capabilities",
  ]),
  CapabilityWorkspaceV1: object({ v, inspect: boolean, staging: boolean }, [
    "v",
    "inspect",
    "staging",
  ]),
  CapabilityStoreV1: object(
    {
      v,
      generic: boolean,
      managedMemory: boolean,
      conditionalWrites: { const: true },
      approval: boolean,
    },
    ["v", "generic", "managedMemory", "conditionalWrites", "approval"],
  ),
  AgentMetadataV1: object(
    {
      v,
      kind: enumeration("agent", "chain", "graph", "workflow"),
      isDefault: boolean,
      schemas: ref("AgentSchemasV1"),
      limits: ref("AgentLimitsV1"),
    },
    ["v", "kind", "isDefault", "schemas", "limits"],
  ),
  HealthResponse: object({ status: { const: "ready" } }, ["status"], false),
  ReadinessResponse: object(
    {
      status: enumeration("ready", "not_ready"),
      checks: {
        type: "object",
        additionalProperties: object(
          { status: enumeration("ready", "not_ready"), code: string },
          ["status"],
          false,
        ),
      },
    },
    ["status", "checks"],
    false,
  ),
  WorkspaceCreate: object(
    {
      sourceDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      environmentLinks: array(object({ path: string, target: string }, ["path", "target"], false)),
      baseline: { const: "git" },
    },
    ["sourceDigest"],
    false,
  ),
  SourceBundle: object(
    {
      version: { const: 1 },
      digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      files: array(
        object(
          { path: string, base64: string, executable: boolean },
          ["path", "base64", "executable"],
          false,
        ),
      ),
    },
    ["version", "digest", "files"],
    false,
  ),
  SourceStageResponse: object(
    {
      digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
      status: enumeration("created", "held"),
    },
    ["digest", "status"],
    false,
  ),
  WorkspaceInspectRequest: object(
    {
      root: string,
      excludeRootDirectories: array(string),
      expectedRootSymlinks: { type: "object", additionalProperties: string },
      ignorePrefixes: array(string),
      maxEntries: { type: "integer", minimum: 0, maximum: 10000 },
      maxFileBytes: { type: "integer", minimum: 0, maximum: 16777216 },
      maxTotalBytes: { type: "integer", minimum: 0, maximum: 33554432 },
    },
    [],
    false,
  ),
  WorkspaceInspectResponse: object(
    {
      threadId: uuid,
      sourceDigest: string,
      intentDigest: string,
      root: string,
      inspection: object(
        {
          files: { type: "object", additionalProperties: string },
          symlinks: { type: "object", additionalProperties: string },
          totalBytes: uint,
          entries: uint,
        },
        ["files", "symlinks", "totalBytes", "entries"],
        false,
      ),
    },
    ["threadId", "sourceDigest", "intentDigest", "inspection"],
    false,
  ),
  StoreApprovalRequest: object(
    { namespace, key: string, if_revision: string },
    ["namespace", "key", "if_revision"],
    false,
  ),
  StoreApprovalResponse: object(
    {
      item: ref("Item"),
      action: enumeration("activated", "superseded", "deduped"),
      superseded: array(ref("Item")),
      removed: array(object({ namespace, key: string }, ["namespace", "key"], false)),
      replayed: boolean,
    },
    ["item", "action", "superseded", "removed", "replayed"],
    false,
  ),
}

export const AGENT_PROTOCOL_NATIVE_SOURCE = {
  repository: "https://github.com/ag-ui-protocol/ag-ui",
  commit: "08eae9dc13546e91272efb2d0ef863e21acc6ee3",
  version: "1.0",
  path: "spec/1.0/schema.json",
  sha256: "4b5c93226838a0e72d88e6c5df20633c686c49fcb75d9be2815c6cbf9e48e71a",
  gitBlobSha1: "c2ce3c18036b6bb2afe583a9b916959e7dcd9b78",
} as const
export const AGENT_PROTOCOL_NATIVE_NOTICE =
  'MIT License\n\nCopyright (c) 2025\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n'
