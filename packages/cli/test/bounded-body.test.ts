import { describe, expect, it } from "vitest"
import {
  payloadTooLarge,
  RequestBodyTooLargeError,
  readBoundedText,
} from "../src/lib/dev/bounded-body.ts"

function streamed(
  chunks: readonly Uint8Array[],
  onPull?: () => void,
  headers: Record<string, string> = {},
) {
  let index = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        onPull?.()
        const chunk = chunks[index++]
        if (chunk) controller.enqueue(chunk)
        else controller.close()
      },
      cancel() {
        cancelled = true
      },
      // No eager pull: a pull only happens when the reader asks, so "nothing was read" is observable.
    },
    { highWaterMark: 0 },
  )
  const request = new Request("http://localhost/x", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" })
  return { request, cancelled: () => cancelled }
}

describe("readBoundedText", () => {
  it("returns a body at or under the limit", async () => {
    const request = new Request("http://localhost/x", { method: "POST", body: "abc" })
    expect(await readBoundedText(request, 3)).toBe("abc")
  })

  it("returns an empty string for a request with no body", async () => {
    expect(await readBoundedText(new Request("http://localhost/x", { method: "POST" }), 3)).toBe("")
  })

  it("refuses a declared content-length over the limit without reading", async () => {
    let pulls = 0
    const { request } = streamed(
      [new Uint8Array(10)],
      () => {
        pulls += 1
      },
      { "content-length": "10" },
    )
    await expect(readBoundedText(request, 5)).rejects.toBeInstanceOf(RequestBodyTooLargeError)
    expect(pulls).toBe(0)
  })

  it("counts streamed bytes and cancels the stream once past the limit", async () => {
    const { request, cancelled } = streamed([
      new Uint8Array(4),
      new Uint8Array(4),
      new Uint8Array(4),
    ])
    const error = await readBoundedText(request, 6).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RequestBodyTooLargeError)
    expect((error as RequestBodyTooLargeError).maxBytes).toBe(6)
    expect(cancelled()).toBe(true)
  })

  it("decodes UTF-8 split across chunks", async () => {
    const bytes = new TextEncoder().encode("héllo")
    const { request } = streamed([bytes.slice(0, 2), bytes.slice(2)])
    expect(await readBoundedText(request, 64)).toBe("héllo")
  })

  it("answers 413 with the limit named", async () => {
    const response = payloadTooLarge(new RequestBodyTooLargeError(1024))
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: { details: { code: "payload_too_large", maxBytes: 1024 } },
    })
  })
})
