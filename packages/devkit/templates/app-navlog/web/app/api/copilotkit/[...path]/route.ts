import { B4HttpAgent } from "@b4run/ag-ui/client"
import { B4AgentRunner } from "@b4run/ag-ui/copilotkit-runtime"
import { CopilotRuntime, createCopilotRuntimeHandler } from "@copilotkit/runtime/v2"
import { guardRequest } from "../../../lib/guarded-request"
import { guardConfigFromEnv, upstreamHeaders } from "../../../lib/proxy-guard"
import { visitorContext } from "../../../lib/visitor-context"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const b4Url = process.env.B4_SERVER_URL ?? "http://127.0.0.1:3002"
const agUiUrl = `${b4Url}/agui/${encodeURIComponent("/navlog#agent")}`

/**
 * Every upstream call (the run, `/info`'s capabilities read, and the runner's
 * replay of `/threads/:id/events`) carries THIS request's visitor id and, when
 * deployed, the internal token. The id travels by context rather than
 * constructor because the agent and runner are shared across requests.
 * CopilotKit copies the browser's `authorization` and `x-*` headers onto the
 * agent for a run (and hands them to the runner's connect, which never
 * forwards them — `B4AgentRunner` builds its replay request from scratch), so
 * the strip protects the run path: a browser-sent `x-b4-visitor` or
 * `x-internal-token` is dropped here before the real one is set. See
 * `lib/proxy-guard.ts` for the guards themselves.
 */
const guardedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  headers.delete("x-b4-visitor")
  headers.delete("x-internal-token")
  const visitorId = visitorContext.getStore()?.visitorId
  // Outside a guarded request there is no visitor; send none rather than
  // invent one, and the deployed server refuses the call.
  if (visitorId !== undefined) {
    const { internalToken } = guardConfigFromEnv()
    for (const [name, value] of Object.entries(upstreamHeaders({ internalToken, visitorId }))) {
      headers.set(name, value)
    }
  }
  return fetch(input, { ...init, headers })
}) as typeof fetch

const agent = new B4HttpAgent({ url: agUiUrl, fetch: guardedFetch })

const handler = createCopilotRuntimeHandler({
  runtime: new CopilotRuntime({
    agents: { default: agent },
    // Restores a thread on `connect` by replaying the server's stored events.
    runner: new B4AgentRunner({ url: b4Url, fetch: guardedFetch }),
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
