import {
  decideRequest,
  type GuardConfig,
  guardConfigFromEnv,
  isValidVisitorId,
  mintVisitorId,
  readCookie,
  VISITOR_COOKIE,
} from "./proxy-guard"
import { limiterVerdict } from "./rate-limit"

/** One year: the visitor id is what owns the visitor's threads. */
const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

export interface GuardedRequest {
  readonly config: GuardConfig
  readonly visitorId: string
  /** The refusal to send instead of forwarding, when the guard refused. */
  readonly rejection: Response | undefined
  /** Adds the visitor cookie when it was minted on this request; returns the response to send. */
  readonly finish: (response: Response) => Response
}

/**
 * Runs the proxy guard for one request (see `proxy-guard.ts`). Takes a plain
 * `Request`, so it works for Next's `NextRequest` and for the runtime test that
 * drives the CopilotKit route with a bare `Request`.
 */
export async function guardRequest(request: Request): Promise<GuardedRequest> {
  const config = guardConfigFromEnv()
  const existing = readCookie(request.headers.get("cookie"), VISITOR_COOKIE)
  const visitorId = isValidVisitorId(existing) ? existing : mintVisitorId()
  const cookie =
    existing === visitorId
      ? undefined
      : `${VISITOR_COOKIE}=${visitorId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${VISITOR_COOKIE_MAX_AGE}${config.internalToken ? "; Secure" : ""}`

  const finish = (response: Response): Response => {
    if (cookie === undefined) return response
    try {
      response.headers.append("set-cookie", cookie)
      return response
    } catch {
      // A response whose headers are immutable (one returned by `fetch`, say)
      // is re-wrapped rather than sent without the cookie.
      const headers = new Headers(response.headers)
      headers.append("set-cookie", cookie)
      return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      })
    }
  }

  const decision = decideRequest({
    ...config,
    origin: request.headers.get("origin") ?? undefined,
    visitorId,
    limiterVerdict: await limiterVerdict(visitorId),
  })
  const rejection =
    decision.kind === "reject"
      ? finish(
          Response.json(
            { error: decision.error },
            {
              status: decision.status,
              ...(decision.status === 429 ? { headers: { "retry-after": "60" } } : {}),
            },
          ),
        )
      : undefined

  return { config, finish, rejection, visitorId }
}
