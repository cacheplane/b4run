import { rm } from "node:fs/promises"
import { type ServeRuntimeHandle, serveRuntime } from "@b4run/cli"
import { type Aimock, createAimock } from "@b4run/testing"
import { type CapturedBuilderHandoff, stagedReferenceOf } from "../src/lib/builder-handoff.ts"
import { createHttpWorkerClient, type WorkerClient } from "../src/lib/worker/client.ts"
import { isolatedBuilder } from "./isolated-builder.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"
import { WORKER_AUTHORIZATION } from "./worker-token-probe.ts"

/**
 * The real builder app (`../../server/`), served by `serveRuntime` from a private copy: one
 * builder for every target and pin, as in production. It boots with no target file and no
 * directory shared with anything: a work order is handed over its Agent Protocol port, as
 * `dispatch` does it (`handOff`): the captured source uploaded, then the thread created
 * naming it, with the work order's target in `factoryBuilder`. The model is one aimock for
 * the whole server; a test scripts it with `aimock.addFixtures`.
 *
 * A thread is created through `POST /threads` with its metadata and staged workspace, which
 * is why these lanes serve the builder rather than use `createAgentHarness`: the harness
 * mints its own thread ids with no metadata, so its threads can never name a work order.
 */
export interface ServedBuilder {
  readonly url: string
  readonly appRoot: string
  readonly aimock: Aimock
  /** The controller's own client for this builder, with the token. */
  readonly client: WorkerClient
  /** Upload a captured handoff's source and create its thread, as `dispatch` does. */
  handOff(captured: CapturedBuilderHandoff): Promise<string>
  /** One turn on `threadId`, waited for: the response status and body text. */
  runTurn(threadId: string, content: string): Promise<{ status: number; text: string }>
  /** The thread's Agent Protocol status (`idle`, `busy`, `interrupted`, ...). */
  threadStatus(threadId: string): Promise<string>
  /** Deletes the given threads (their workspaces with them), stops the server, restores env. */
  close(threads?: readonly string[]): Promise<void>
}

/** What the served builder reads from the process: restored by `close`. */
const ENV = [
  "FACTORY_BUILDER_MANIFEST_DIR",
  "FACTORY_BUILDER_TARGET",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "B4_PERMISSIONS_MODE",
  "FACTORY_WORKER_TOKEN",
] as const

export async function serveBuilder(): Promise<ServedBuilder> {
  const previous: Partial<Record<(typeof ENV)[number], string | undefined>> = {}
  for (const key of ENV) previous[key] = process.env[key]
  const restore = () => {
    for (const key of ENV) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  const appRoot = await isolatedBuilder()
  let aimock: Aimock | undefined
  let server: ServeRuntimeHandle | undefined
  try {
    aimock = await createAimock({ fixtures: [] })
    // Read by `b4.config.ts` at module load and by the model layer when the route first
    // builds its model: set before the app boots in this process. The builder's permissions
    // mode is its own; an operator's process-wide override is not this lane's. The retired
    // variables are unset: the builder refuses to boot while either is set.
    delete process.env.FACTORY_BUILDER_MANIFEST_DIR
    delete process.env.FACTORY_BUILDER_TARGET
    process.env.OPENAI_BASE_URL = aimock.baseUrl
    process.env.OPENAI_API_KEY = "test"
    // The builder's thread-access policy reads it at boot and admits only callers presenting
    // it, as the controller does; every request this helper makes carries it.
    process.env.FACTORY_WORKER_TOKEN = TEST_WORKER_TOKEN
    delete process.env.B4_PERMISSIONS_MODE
    server = await serveRuntime({ appRoot, host: "127.0.0.1", port: 0 })
  } catch (error) {
    await server?.close()
    await aimock?.close()
    await rm(appRoot, { recursive: true, force: true })
    restore()
    throw error
  }
  const url = server.url
  const served = server
  const model = aimock
  const client = createHttpWorkerClient(url, { token: TEST_WORKER_TOKEN })
  return {
    url,
    appRoot,
    aimock: model,
    client,
    async handOff(captured) {
      await client.uploadSource(captured.workspace.source)
      return client.createThread(
        { factoryWorkOrderId: captured.handoff.workOrderId, factoryBuilder: captured.handoff },
        stagedReferenceOf(captured.workspace),
      )
    },
    async runTurn(threadId, content) {
      const response = await fetch(`${url}/threads/${encodeURIComponent(threadId)}/runs/wait`, {
        method: "POST",
        headers: { "content-type": "application/json", ...WORKER_AUTHORIZATION },
        body: JSON.stringify({
          route: "/build#agent",
          input: { messages: [{ role: "user", content }] },
        }),
      })
      return { status: response.status, text: await response.text() }
    },
    async threadStatus(threadId) {
      const response = await fetch(`${url}/threads/${encodeURIComponent(threadId)}`, {
        headers: WORKER_AUTHORIZATION,
      })
      return ((await response.json()) as { status: string }).status
    },
    async close(threads = []) {
      try {
        for (const threadId of threads)
          await fetch(`${url}/threads/${encodeURIComponent(threadId)}`, {
            method: "DELETE",
            headers: WORKER_AUTHORIZATION,
          })
      } finally {
        await served.close()
        await model.close()
        await rm(appRoot, { recursive: true, force: true })
        restore()
      }
    },
  }
}

/** A tool result as the model saw it: a JSON-encoded string result decoded once. */
export function toolResultText(message: { content: unknown }): string {
  const raw = String(message.content)
  try {
    const decoded: unknown = JSON.parse(raw)
    return typeof decoded === "string" ? decoded : raw
  } catch {
    return raw
  }
}

/** The tool messages of the LAST request aimock received: every result of the turn so far. */
export function toolResults(aimock: Aimock): string[] {
  const messages = aimock.getRequests().at(-1)?.body?.messages ?? []
  return messages.filter((m) => m.role === "tool").map(toolResultText)
}

/** The tool calls the model was asked for in the last request, in order. */
export function toolCallsSeen(aimock: Aimock): string[] {
  const messages = aimock.getRequests().at(-1)?.body?.messages ?? []
  return messages.flatMap((message) => {
    if (message.role !== "assistant") return []
    const calls = (message as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls
    return (calls ?? []).map((call) => call.function?.name ?? "?")
  })
}
