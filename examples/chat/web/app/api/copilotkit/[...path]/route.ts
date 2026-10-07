import { B4HttpAgent } from "@b4run/ag-ui/client"
import { createB4AgentRunner } from "@b4run/ag-ui/copilotkit-runtime"
import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
  InMemoryAgentRunner,
} from "@copilotkit/runtime/v2"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const b4Url = process.env.B4_SERVER_URL ?? "http://127.0.0.1:3001"
const agUiUrl = `${b4Url}/agui/${encodeURIComponent("/chat#agent")}`

const handler = createCopilotRuntimeHandler({
  runtime: new CopilotRuntime({
    agents: { default: new B4HttpAgent({ url: agUiUrl }) },
    // `connect` restores a thread by replaying `GET /threads/:id/events` from the B4.run
    // server, so a reload (or a restarted Next process) brings the chat back. This local
    // example has no callers to tell apart, so the replay uses the default `fetch`; an app
    // with users passes a `fetch` that carries the current caller (see the navlog example).
    runner: createB4AgentRunner(InMemoryAgentRunner, { url: b4Url }),
  }),
  basePath: "/api/copilotkit",
})

export const GET = handler
export const POST = handler
