import { createServer, type IncomingMessage } from "node:http"
import { type AddressInfo, connect } from "node:net"
import { Readable } from "node:stream"
import { expect, it } from "vitest"
import {
  payloadTooLarge,
  RequestBodyTooLargeError,
  readBoundedText,
} from "../src/lib/dev/bounded-body.ts"
import { toWebRequest, writeNodeResponse } from "../src/lib/dev/node-web-adapter.ts"

/**
 * The server under test: `/bounded` reads its body with a 1 KiB ceiling, `/ignore`
 * answers without touching its body.
 */
async function serve() {
  const server = createServer((req, res) => {
    void (async () => {
      const request = toWebRequest(req, res)
      if (req.url === "/ignore") {
        await writeNodeResponse(res, Response.json({ ignored: true }))
        return
      }
      try {
        const text = await readBoundedText(request, 1024)
        await writeNodeResponse(res, Response.json({ length: text.length }))
      } catch (error) {
        if (!(error instanceof RequestBodyTooLargeError)) throw error
        await writeNodeResponse(res, payloadTooLarge(error))
      }
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * One raw connection: the whole of `first` (headers and every body byte), then a
 * pipelined `POST /bounded` of "ok" asking to close. Returns everything the server
 * wrote until it closed. A raw socket, not `fetch`, because a fetch client may stop
 * uploading once it has its answer: this client always sends the whole upload, so
 * the second answer arrives only if the server discarded the first body and kept
 * the connection.
 */
async function exchange(port: number, first: readonly Buffer[]): Promise<string> {
  const socket = connect(port, "127.0.0.1")
  const received: Buffer[] = []
  socket.on("data", (chunk: Buffer) => received.push(chunk))
  const ended = new Promise<void>((resolve, reject) => {
    socket.on("end", resolve)
    socket.on("error", reject)
  })
  const write = (chunk: Buffer) =>
    new Promise<void>((resolve, reject) =>
      socket.write(chunk, (error) => (error ? reject(error) : resolve())),
    )
  for (const chunk of first) await write(chunk)
  await write(
    Buffer.from(
      "POST /bounded HTTP/1.1\r\nhost: x\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
    ),
  )
  await ended
  return Buffer.concat(received).toString("latin1")
}

const upload = Buffer.alloc(4 * 1024 * 1024, "x")
const head = (path: string, framing: string) =>
  Buffer.from(`POST ${path} HTTP/1.1\r\nhost: x\r\n${framing}\r\n`)
const chunked = (bytes: Buffer) => {
  const parts: Buffer[] = []
  for (let at = 0; at < bytes.length; at += 64 * 1024) {
    const piece = bytes.subarray(at, at + 64 * 1024)
    parts.push(Buffer.from(`${piece.length.toString(16)}\r\n`), piece, Buffer.from("\r\n"))
  }
  parts.push(Buffer.from("0\r\n\r\n"))
  return parts
}

const cases = {
  // Refused on the header, before a byte is read.
  "a declared body over the limit": [
    head("/bounded", `content-length: ${upload.length}\r\n`),
    upload,
  ],
  // Refused mid-stream, once the count passes the limit.
  "a chunked body that passes the limit": [
    head("/bounded", "transfer-encoding: chunked\r\n"),
    ...chunked(upload),
  ],
} as const

for (const [name, request] of Object.entries(cases)) {
  it(`answers ${name} with a whole 413, discards the upload and keeps serving`, async () => {
    const server = await serve()
    try {
      const wire = await exchange(server.port, request)
      const answers = wire.split(/(?=HTTP\/1\.1 )/)
      expect(answers).toHaveLength(2)
      expect(answers[0]).toMatch(/^HTTP\/1\.1 413 /)
      expect(answers[0]).toContain('"code":"payload_too_large"')
      expect(answers[1]).toMatch(/^HTTP\/1\.1 200 /)
      expect(answers[1]).toContain('{"length":2}')
    } finally {
      await server.close()
    }
  })
}

it("leaves a body the handler never reads to Node, which discards it and keeps serving", async () => {
  const server = await serve()
  try {
    const wire = await exchange(server.port, [
      head("/ignore", `content-length: ${upload.length}\r\n`),
      upload,
    ])
    const answers = wire.split(/(?=HTTP\/1\.1 )/)
    expect(answers).toHaveLength(2)
    expect(answers[0]).toContain('{"ignored":true}')
    expect(answers[1]).toContain('{"length":2}')
  } finally {
    await server.close()
  }
})

it("rejects a body read that starts after the client dropped mid-upload, never hanging", async () => {
  let settled!: (outcome: string) => void
  const outcome = new Promise<string>((resolve) => {
    settled = resolve
  })
  const server = createServer((req, res) => {
    const request = toWebRequest(req, res)
    // The read starts only after the drop, as a route that awaits a lookup and a policy does.
    setTimeout(() => {
      request.text().then(
        () => settled("resolved"),
        (error: unknown) => settled(`rejected: ${error instanceof Error ? error.message : error}`),
      )
    }, 300)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const socket = connect((server.address() as AddressInfo).port, "127.0.0.1")
    socket.on("error", () => {})
    await new Promise<void>((resolve) => socket.on("connect", resolve))
    socket.write("POST /x HTTP/1.1\r\nhost: x\r\ncontent-length: 1000\r\n\r\npartial")
    await new Promise((resolve) => setTimeout(resolve, 50))
    socket.destroy()
    const result = await Promise.race([
      outcome,
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 3000)),
    ])
    expect(result).toMatch(/^rejected/)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it("rejects a body whose source closes mid-read with neither an end nor an error", async () => {
  // A stream that is destroyed without an error emits only `close`: the one signal left.
  const source = Object.assign(new Readable({ read() {} }), {
    headers: { host: "x", "content-length": "100" },
    method: "POST",
    url: "/x",
  })
  const request = toWebRequest(source as unknown as IncomingMessage)
  const reading = request.text()
  source.push("partial")
  await new Promise((resolve) => setTimeout(resolve, 10))
  source.destroy()
  const result = await Promise.race([
    reading.then(
      () => "resolved",
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : error}`,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 2000)),
  ])
  expect(result).toBe("rejected: aborted")
})
