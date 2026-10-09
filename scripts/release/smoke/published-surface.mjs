// The public surface the release smoke probes expect of the published packages.
//
// The smoke lanes install the packages from npm and import them, so they first
// run after publication, from the frozen candidate: a stale expectation here fails
// a release that cannot be fixed in place (v0.14.0's AG-UI root list). Each owning
// package's tests compare this declaration with what the package really exports,
// and scripts/release/test/published-surface.test.mjs holds every probe's @b4run
// imports to it, so a public-surface change fails pull-request CI instead.

/** Root constants of @b4run/ag-ui and the values the ESM probe asserts, in probe order. */
export const AG_UI_ROOT_CONSTANTS = Object.freeze({
  B4_PLAN_ACTIVITY_TYPE: "b4.plan",
  B4_CONTENT_PARTS_DROPPED_EVENT: "b4.content_parts_dropped",
})

/** Root functions of @b4run/ag-ui. */
export const AG_UI_ROOT_FUNCTIONS = Object.freeze([
  "createCounterIdFactory",
  "createDefaultIdFactory",
  "fromRunAgentInput",
  "toAguiEvents",
])

/** The complete, sorted root value surface of @b4run/ag-ui: the ESM probe compares exactly. */
export const AG_UI_ROOT_EXPORTS = Object.freeze(
  [...Object.keys(AG_UI_ROOT_CONSTANTS), ...AG_UI_ROOT_FUNCTIONS].sort(),
)

/** Types the TypeScript probe imports from the @b4run/ag-ui root. */
export const AG_UI_ROOT_TYPES = Object.freeze([
  "AguiOutboundEvent",
  "B4AgentStreamChunk",
  "B4InterruptEnvelope",
  "B4Message",
  "B4PlanActivityContent",
  "B4ResumeRequest",
  "B4RunInput",
  "IdFactory",
  "RunContext",
  "ToAguiOptions",
])

/** Types the TypeScript probe expects to stay absent from the @b4run/ag-ui root. */
export const AG_UI_REMOVED_ROOT_TYPES = Object.freeze([
  "AgUiEvent",
  "AgUiTranslator",
  "B4StreamChunk",
  "B4ToolCallData",
  "B4ToolResultData",
  "MappedRunInput",
  "RawChunk",
  "ResumeDecision",
  "TranslatorOptions",
])

/** Values the TypeScript probe expects to stay absent from the @b4run/ag-ui root. */
export const AG_UI_REMOVED_ROOT_VALUES = Object.freeze([
  "asToolCallData",
  "asToolResultData",
  "createAgUiTranslator",
  "encodeAgUiSse",
  "fromAguiResume",
  "mapRunInput",
  "toAguiInterrupt",
])

/**
 * Every named value import of every release smoke probe, by specifier, with the
 * `typeof` the probe relies on.
 */
export const PUBLISHED_PROBE_IMPORTS = Object.freeze({
  "@b4run/ag-ui": Object.freeze({
    B4_PLAN_ACTIVITY_TYPE: "string",
    createCounterIdFactory: "function",
    createDefaultIdFactory: "function",
    fromRunAgentInput: "function",
    toAguiEvents: "function",
  }),
  "@b4run/ag-ui/sse": Object.freeze({
    agUiContentType: "function",
    encodeAgUiEvent: "function",
  }),
  "@b4run/core/node": Object.freeze({
    discoverRoutes: "function",
    extractToolSchemasForRoute: "function",
    extractToolTypesForRoute: "function",
  }),
  "@b4run/langchain": Object.freeze({ openaiEmbedder: "function" }),
  "@b4run/langgraph": Object.freeze({ graphAdapter: "object" }),
  "@b4run/memory-pgvector": Object.freeze({ pgvectorMemoryStore: "function" }),
  "@b4run/postgres-storage": Object.freeze({ createPostgresThreadsStore: "function" }),
  "@b4run/postgres-storage/node": Object.freeze({ createPostgresThreadsStore: "function" }),
  "@b4run/sandbox": Object.freeze({ dockerSandbox: "function" }),
  "@b4run/sdk": Object.freeze({
    agent: "function",
    allow: "function",
    defineMiddleware: "function",
    reject: "function",
  }),
  "@b4run/testing": Object.freeze({ createAimock: "function" }),
  "@b4run/vite-plugin": Object.freeze({ b4ToolSchemaPlugin: "function" }),
})

/** The backend adapter contract the harness and runtime-target probes assert of graphAdapter. */
export const GRAPH_ADAPTER_CONTRACT = Object.freeze({
  kind: "graph",
  methods: Object.freeze(["execute", "stream"]),
})
