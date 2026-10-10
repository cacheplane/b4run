import { B4HttpAgent } from "@b4run/ag-ui/client"
import { createB4AgentRunner, forwardIdentity } from "@b4run/ag-ui/copilotkit-runtime"
import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
  InMemoryAgentRunner,
} from "@copilotkit/runtime/v2"
import { guardRequest } from "../../../lib/guarded-request"
import { guardConfigFromEnv, upstreamHeaders } from "../../../lib/proxy-guard"
import { visitorContext } from "../../../lib/visitor-context"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const b4Url = process.env.B4_SERVER_URL ?? "http://127.0.0.1:3002"
const agUiUrl = `${b4Url}/agui/${encodeURIComponent("/compliance#agent")}`

/**
 * Every upstream call (the run, `/info`'s capabilities read, and the runner's
 * replay of `/threads/:id/events`) carries THIS request's visitor id and, when
 * deployed, the internal token. The id travels by context rather than
 * constructor because the agent and runner are shared across requests.
 * `forwardIdentity` strips both headers from whatever the call carried first:
 * CopilotKit copies the browser's `authorization` and `x-*` headers onto the
 * agent for a run, so a browser-sent `x-b4-visitor` or `x-internal-token` is
 * dropped before the real one is set. Outside a guarded request there is no
 * visitor; it sends none rather than invent one, and the deployed server
 * refuses the call. See `lib/proxy-guard.ts` for the guards themselves.
 */
const guardedFetch = forwardIdentity({
  headers: ["x-b4-visitor", "x-internal-token"],
  resolve: () => {
    const visitorId = visitorContext.getStore()?.visitorId
    if (visitorId === undefined) return undefined
    return upstreamHeaders({ internalToken: guardConfigFromEnv().internalToken, visitorId })
  },
})

/** The compliance route answers in markdown, so no response schema is sent. */
const agent = new B4HttpAgent({ url: agUiUrl, fetch: guardedFetch })

const handler = createCopilotRuntimeHandler({
  runtime: new CopilotRuntime({
    agents: { default: agent },
    // Restores a thread on `connect` by replaying the server's stored events.
    // CopilotKit's own runner class is passed in, so `@b4run/ag-ui` never has to
    // resolve `@copilotkit/runtime` itself.
    runner: createB4AgentRunner(InMemoryAgentRunner, { url: b4Url, fetch: guardedFetch }),
  }),
  basePath: "/api/copilotkit",
})

async function guarded(request: Request): Promise<Response> {
  const guard = await guardRequest(request, "copilotkit")
  if (guard.rejection !== undefined) return guard.rejection
  const response = await visitorContext.run({ visitorId: guard.visitorId }, () => handler(request))
  return guard.finish(response)
}

export const GET = guarded
export const POST = guarded
