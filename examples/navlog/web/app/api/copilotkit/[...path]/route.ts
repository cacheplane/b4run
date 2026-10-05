import { B4HttpAgent } from "@b4run/ag-ui/client"
import { CopilotRuntime, createCopilotRuntimeHandler } from "@copilotkit/runtime/v2"
import { guardRequest } from "../../../lib/guarded-request"
import { guardConfigFromEnv, upstreamHeaders } from "../../../lib/proxy-guard"
import { visitorContext } from "../../../lib/visitor-context"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const b4Url = process.env.B4_SERVER_URL ?? "http://127.0.0.1:3002"
const agUiUrl = `${b4Url}/agui/${encodeURIComponent("/navlog#agent")}`

// One agent for the process, so the visitor id travels by context rather than
// constructor: every upstream call (the run, and the capabilities read behind
// `/info`) picks up the current request's visitor id and, when deployed, the
// internal token. See `lib/proxy-guard.ts` for the guards themselves.
const agent = new B4HttpAgent({
  url: agUiUrl,
  fetch: (input, init) => {
    const visitorId = visitorContext.getStore()?.visitorId
    const headers = new Headers(init?.headers)
    // Outside a guarded request there is no visitor; send none rather than
    // invent one, and the deployed server refuses the call.
    if (visitorId !== undefined) {
      const { internalToken } = guardConfigFromEnv()
      for (const [name, value] of Object.entries(upstreamHeaders({ internalToken, visitorId }))) {
        headers.set(name, value)
      }
    }
    return fetch(input, { ...init, headers })
  },
})

const handler = createCopilotRuntimeHandler({
  runtime: new CopilotRuntime({
    agents: { default: agent },
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
