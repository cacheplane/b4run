import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { MiddlewareHandler, ThreadAccessPolicy } from "@b4run/sdk"
import { afterEach, describe, expect, it } from "vitest"
import {
  MAX_ENVELOPE_ID_LENGTH,
  resolveRunEnvelopePolicy,
  validateRunEnvelope,
} from "../src/lib/dev/run-envelope.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const TRIVIAL_ROUTE = "export const graph = async () => ({ ok: true })\n"
const HELLO_ROUTE = "/hello#graph"
const OTHER_ROUTE = "/other#graph"

async function setup(
  options: {
    readonly config?: string
    readonly middleware?: MiddlewareHandler
    readonly threadAccess?: ThreadAccessPolicy
  } = {},
): Promise<{ readonly handler: Awaited<ReturnType<typeof createRuntimeFetchHandler>> }> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-agui-envelope-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  const files: Record<string, string> = {
    "b4.config.ts": options.config ?? "export default {}\n",
    "package.json": '{ "name": "agui-envelope-fixture", "type": "module" }\n',
    "src/app/hello/index.ts": TRIVIAL_ROUTE,
    "src/app/other/index.ts": TRIVIAL_ROUTE,
  }
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = join(appRoot, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, "utf8")
  }
  const handler = await createRuntimeFetchHandler({
    appRoot,
    drainDeadlineMs: 250,
    ...(options.middleware ? { middleware: options.middleware } : {}),
    ...(options.threadAccess ? { threadAccess: options.threadAccess } : {}),
  })
  cleanup.push(() => handler.close())
  return { handler }
}

/** A schema-valid `RunAgentInput` body, with the caller's overrides applied last. */
function aguiPost(routeKey: string, payload: Record<string, unknown> = {}): Request {
  return new Request(new URL(`/agui/${encodeURIComponent(routeKey)}`, "http://localhost"), {
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    method: "POST",
    body: JSON.stringify({
      threadId: "t-1",
      runId: "run-1",
      messages: [],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
      ...payload,
    }),
  })
}

async function drain(response: Response): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) return
  for (;;) {
    const { done } = await reader.read()
    if (done) return
  }
}

interface ErrorBody {
  readonly error: {
    readonly code?: string
    readonly docsUrl?: string
    readonly kind: string
    readonly message: string
    readonly details?: { readonly code?: string }
  }
}

async function rejection(response: Response): Promise<ErrorBody["error"]> {
  return ((await response.json()) as ErrorBody).error
}

// ---------------------------------------------------------------------------
// The pure validator
// ---------------------------------------------------------------------------

const OPEN = { clientTools: true, forwardedProps: true } as const
const CLOSED = { clientTools: false, forwardedProps: false } as const

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { threadId: "t-1", runId: "run-1", state: {}, ...overrides }
}

describe("validateRunEnvelope", () => {
  it("accepts a well-formed closed envelope", () => {
    expect(validateRunEnvelope(envelope(), CLOSED)).toBeUndefined()
    expect(validateRunEnvelope(envelope({ tools: [], forwardedProps: {} }), CLOSED)).toBeUndefined()
  })

  it("accepts an absent state, which means the turn carries none", () => {
    expect(validateRunEnvelope({ threadId: "t-1", runId: "run-1" }, CLOSED)).toBeUndefined()
  })

  it.each([
    ["an empty thread id", { threadId: "" }, "invalid_thread_id"],
    ["a whitespace-only thread id", { threadId: "   " }, "invalid_thread_id"],
    [
      "an over-long thread id",
      { threadId: "t".repeat(MAX_ENVELOPE_ID_LENGTH + 1) },
      "invalid_thread_id",
    ],
    ["a non-string thread id", { threadId: 7 }, "invalid_thread_id"],
    ["an empty run id", { runId: "" }, "invalid_run_id"],
    ["a whitespace-only run id", { runId: "\t\n" }, "invalid_run_id"],
    ["an over-long run id", { runId: "r".repeat(MAX_ENVELOPE_ID_LENGTH + 1) }, "invalid_run_id"],
    ["a string state", { state: "nope" }, "invalid_state"],
    ["an array state", { state: [] }, "invalid_state"],
    ["a null state", { state: null }, "invalid_state"],
  ])("rejects %s", (_label, overrides, code) => {
    expect(validateRunEnvelope(envelope(overrides), CLOSED)).toMatchObject({ code, status: 422 })
  })

  it("rejects a body that is not an object at all", () => {
    expect(validateRunEnvelope([], CLOSED)).toMatchObject({ code: "invalid_envelope" })
  })

  it("rejects client-supplied tools and forwardedProps when the route did not opt in", () => {
    expect(
      validateRunEnvelope(
        envelope({ tools: [{ name: "wire", description: "", parameters: {} }] }),
        CLOSED,
      ),
    ).toMatchObject({ code: "client_tools_not_allowed", status: 422 })
    expect(validateRunEnvelope(envelope({ forwardedProps: { a: 1 } }), CLOSED)).toMatchObject({
      code: "forwarded_props_not_allowed",
      status: 422,
    })
  })

  it("rejects a malformed tools/forwardedProps shape even when the route opted in", () => {
    expect(validateRunEnvelope(envelope({ tools: "nope" }), OPEN)).toMatchObject({
      code: "client_tools_not_allowed",
    })
    expect(validateRunEnvelope(envelope({ forwardedProps: [] }), OPEN)).toMatchObject({
      code: "forwarded_props_not_allowed",
    })
  })

  it("accepts client-supplied tools and forwardedProps when the route opted in", () => {
    expect(
      validateRunEnvelope(
        envelope({
          tools: [{ name: "wire", description: "", parameters: {} }],
          forwardedProps: { a: 1 },
        }),
        OPEN,
      ),
    ).toBeUndefined()
  })

  it("checks identity before authority, so a malformed id is reported first", () => {
    expect(
      validateRunEnvelope(envelope({ threadId: "", forwardedProps: { a: 1 } }), CLOSED),
    ).toMatchObject({ code: "invalid_thread_id" })
  })
})

describe("resolveRunEnvelopePolicy", () => {
  it("is closed with no config at all", () => {
    expect(resolveRunEnvelopePolicy(undefined, "/hello")).toEqual(CLOSED)
  })

  it("opens only the route ids the config names, and only the field it names", () => {
    const config = { server: { agui: { clientTools: ["/hello"] } } }
    expect(resolveRunEnvelopePolicy(config, "/hello")).toEqual({
      clientTools: true,
      forwardedProps: false,
    })
    expect(resolveRunEnvelopePolicy(config, "/other")).toEqual(CLOSED)
  })

  it("opens forwardedProps independently of tools", () => {
    const config = { server: { agui: { clientForwardedProps: ["/hello"] } } }
    expect(resolveRunEnvelopePolicy(config, "/hello")).toEqual({
      clientTools: false,
      forwardedProps: true,
    })
  })
})

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

describe("POST /agui/:routeId envelope validation", () => {
  it("rejects a blank thread id with a coded 422", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(aguiPost(HELLO_ROUTE, { threadId: " " }))

    expect(response.status).toBe(422)
    const error = await rejection(response)
    expect(error).toMatchObject({
      code: "B4_E5401",
      kind: "request_error",
      details: { code: "invalid_thread_id" },
    })
    expect(error.docsUrl).toBe("https://b4.run/docs/ag-ui#envelope-validation")
  })

  it("rejects an over-long thread id", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(
      aguiPost(HELLO_ROUTE, { threadId: "t".repeat(MAX_ENVELOPE_ID_LENGTH + 1) }),
    )

    expect(response.status).toBe(422)
    expect((await rejection(response)).details?.code).toBe("invalid_thread_id")
  })

  it("rejects a state that is not a JSON object", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(aguiPost(HELLO_ROUTE, { state: "nope" }))

    expect(response.status).toBe(422)
    expect((await rejection(response)).details?.code).toBe("invalid_state")
  })

  it("rejects client-supplied tools by default", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(
      aguiPost(HELLO_ROUTE, {
        tools: [{ name: "exfiltrate", description: "", parameters: { type: "object" } }],
      }),
    )

    expect(response.status).toBe(422)
    expect((await rejection(response)).details?.code).toBe("client_tools_not_allowed")
  })

  it("rejects client-supplied forwardedProps by default", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(
      aguiPost(HELLO_ROUTE, { forwardedProps: { role: "admin" } }),
    )

    expect(response.status).toBe(422)
    expect((await rejection(response)).details?.code).toBe("forwarded_props_not_allowed")
  })

  it("still accepts the empty tools/forwardedProps every AG-UI client sends", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(aguiPost(HELLO_ROUTE))

    expect(response.status).toBe(200)
    await drain(response)
  })

  it("honors a per-route opt-in from b4.config.ts", async () => {
    const { handler } = await setup({
      config:
        'export default { server: { agui: { clientTools: ["/hello"], clientForwardedProps: ["/hello"] } } }\n',
    })

    const allowed = await handler.fetch(
      aguiPost(HELLO_ROUTE, {
        tools: [{ name: "wire", description: "", parameters: { type: "object" } }],
        forwardedProps: { role: "admin" },
      }),
    )
    expect(allowed.status).toBe(200)
    await drain(allowed)

    // The opt-in is keyed on the route that asked for it, not on the app.
    const denied = await handler.fetch(
      aguiPost(OTHER_ROUTE, {
        threadId: "t-2",
        tools: [{ name: "wire", description: "", parameters: { type: "object" } }],
      }),
    )
    expect(denied.status).toBe(422)
    expect((await rejection(denied)).details?.code).toBe("client_tools_not_allowed")
  })

  it("rejects before route middleware and before the thread-access policy run", async () => {
    const middlewareCalls: string[] = []
    const policyCalls: string[] = []
    const { handler } = await setup({
      middleware: (request) => {
        middlewareCalls.push(request.routeId)
        return { action: "continue" }
      },
      threadAccess: {
        fallback: (request) => {
          policyCalls.push(request.operation)
          return { decision: "allow" }
        },
      },
    })

    const response = await handler.fetch(aguiPost(HELLO_ROUTE, { forwardedProps: { a: 1 } }))

    expect(response.status).toBe(422)
    expect(middlewareCalls).toEqual([])
    expect(policyCalls).toEqual([])
  })

  it("leaves a resume that names no pending interrupt to the existing 409", async () => {
    const { handler } = await setup()
    const response = await handler.fetch(
      aguiPost(HELLO_ROUTE, {
        resume: [{ interruptId: "nope", status: "resolved", payload: "once" }],
      }),
    )

    expect(response.status).toBe(409)
    expect((await rejection(response)).details?.code).toBe("stale_interrupt")
  })
})
