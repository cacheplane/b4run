import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { z } from "zod"
import {
  CommandInFlightError,
  type Factory,
  UnknownTaskError,
  UnknownWorkOrderError,
} from "./controller/factory.js"
import { DIGEST_PATTERN } from "./domain/work-order.js"

export interface HttpApi {
  readonly baseUrl: string
  close(): Promise<void>
}

const CreateBody = z.object({
  taskId: z.string().min(1),
  operationKey: z.string().min(1).optional(),
})
const KeyBody = z.object({ operationKey: z.string().min(1).optional() }).default({})
const ApproveBody = z.object({
  revision: z.number().int().nonnegative(),
  candidateDigest: z.string().regex(DIGEST_PATTERN),
  operationKey: z.string().min(1).optional(),
})

const MAX_BODY_BYTES = 1024 * 1024

class PayloadTooLargeError extends Error {
  constructor() {
    super("Body too large")
    this.name = "PayloadTooLargeError"
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > MAX_BODY_BYTES) throw new PayloadTooLargeError()
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  return text === "" ? {} : JSON.parse(text)
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

/** Loopback-only JSON surface over the factory commands. No authentication (spec: out of scope). */
export function createHttpApi(factory: Factory): { listen(port: number): Promise<HttpApi> } {
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const parts = url.pathname.split("/").filter(Boolean)
      if (parts[0] !== "work-orders") return send(res, 404, { error: "Not found" })
      const id = parts[1]
      const action = parts[2]

      if (req.method === "GET" && !id) return send(res, 200, factory.list())
      if (req.method === "POST" && !id) {
        const { taskId, operationKey } = CreateBody.parse(await readJson(req))
        return send(
          res,
          201,
          await factory.create({ taskId, ...(operationKey ? { operationKey } : {}) }),
        )
      }
      if (!id) return send(res, 404, { error: "Not found" })
      if (req.method === "GET" && !action) {
        const row = factory.show(id)
        return row ? send(res, 200, row) : send(res, 404, { error: "Unknown work order" })
      }
      if (req.method === "GET" && action === "events") {
        if (!factory.show(id)) return send(res, 404, { error: "Unknown work order" })
        return send(res, 200, factory.events(id))
      }
      if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" })
      const body = await readJson(req)
      let outcome: Awaited<ReturnType<Factory["dispatch"]>> | null
      if (action === "dispatch")
        outcome = await factory.dispatch(id, KeyBody.parse(body).operationKey)
      else if (action === "approve") {
        const { revision, candidateDigest, operationKey } = ApproveBody.parse(body)
        outcome = await factory.approve(id, {
          revision,
          candidateDigest,
          ...(operationKey ? { operationKey } : {}),
        })
      } else if (action === "deny")
        outcome = await factory.deny(id, KeyBody.parse(body).operationKey)
      else if (action === "cancel")
        outcome = await factory.cancel(id, KeyBody.parse(body).operationKey)
      else outcome = null
      if (!outcome) return send(res, 404, { error: "Not found" })
      return send(res, outcome.ok ? 200 : 409, outcome)
    } catch (error) {
      if (error instanceof z.ZodError)
        return send(res, 400, { error: "Invalid body", issues: error.issues })
      if (error instanceof UnknownTaskError) return send(res, 400, { error: error.message })
      if (error instanceof UnknownWorkOrderError) return send(res, 404, { error: error.message })
      if (error instanceof CommandInFlightError) return send(res, 409, { error: error.message })
      if (error instanceof PayloadTooLargeError) return send(res, 413, { error: error.message })
      if (error instanceof SyntaxError) return send(res, 400, { error: "Malformed JSON" })
      return send(res, 500, { error: String(error) })
    }
  })
  return {
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, "127.0.0.1", () => {
          const address = server.address()
          if (typeof address !== "object" || address === null)
            return reject(new Error("did not bind"))
          resolve({
            baseUrl: `http://127.0.0.1:${address.port}`,
            close: () =>
              new Promise<void>((done) => {
                server.closeAllConnections()
                server.close(() => done())
              }),
          })
        })
      })
    },
  }
}
