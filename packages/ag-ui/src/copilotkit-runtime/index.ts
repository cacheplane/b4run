/**
 * `@b4run/ag-ui/copilotkit-runtime` — the server half of the CopilotKit
 * connector: a CopilotKit runtime runner whose `connect` restores a thread
 * from B4's storage. `@copilotkit/runtime` (>=1.76, the v2 API) and `rxjs`
 * are optional peer dependencies of `@b4run/ag-ui`; this is the only entry
 * that imports them. Node only.
 */
export { B4AgentRunner, type B4AgentRunnerOptions } from "./B4AgentRunner.js"
