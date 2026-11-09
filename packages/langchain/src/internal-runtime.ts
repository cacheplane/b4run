/** Trusted CLI/runtime plumbing; no author-facing root export. */
export { agentBackendAdapter, bindMaterializedAgentRuntime } from "./agent-adapter.js"
export { bindRuntimeChildReplayReader } from "./replay-checkpoint-reader.js"
