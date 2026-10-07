/**
 * `@b4run/ag-ui/copilotkit-runtime` — the server half of the CopilotKit
 * connector: a CopilotKit runtime runner whose `connect` restores a thread
 * from B4's storage. It never imports `@copilotkit/runtime`: the host passes
 * CopilotKit's `InMemoryAgentRunner` class in, so the runner extends the copy
 * the host's runtime resolves, wherever the package manager placed it.
 * Node only.
 *
 * ```ts
 * import { InMemoryAgentRunner } from "@copilotkit/runtime/v2"
 * import { createB4AgentRunner } from "@b4run/ag-ui/copilotkit-runtime"
 * const runner = createB4AgentRunner(InMemoryAgentRunner, { url, fetch })
 * ```
 */
export {
  type B4AgentRunnerBase,
  type B4AgentRunnerOptions,
  createB4AgentRunner,
} from "./createB4AgentRunner.js"
