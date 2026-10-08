import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, expect, it } from "vitest"
import { createAimock, pairRecordings } from "../src/aimock-runner.js"

it("getRecordingsSince windows to a single run (no cross-burst misalignment)", async () => {
  const upstream = await createAimock({
    fixtures: [
      { match: { userMessage: "first" }, response: { content: "ONE" } },
      { match: { userMessage: "second" }, response: { content: "TWO" } },
    ],
  })
  const recorder = await createAimock({
    fixtures: [],
    proxy: { openai: upstream.baseUrl.replace(/\/v1$/, "") },
    record: true,
  })
  afterAll(async () => {
    await recorder.close()
    await upstream.close()
  })

  const call = async (content: string) => {
    const r = await fetch(`${recorder.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content }] }),
    })
    expect(r.ok).toBe(true)
  }

  // Burst 1
  const j0 = 0,
    f0 = recorder.getFixtureCount()
  await call("first")
  const burst1 = recorder.getRecordingsSince(j0, f0)
  expect(burst1).toHaveLength(1)
  expect(burst1[0]?.response).toMatchObject({ content: "ONE" })
  expect(burst1[0]?.request.messages?.[0]).toEqual({ role: "user", content: "first" })

  // Burst 2 — windowed from AFTER burst 1; must NOT re-surface burst 1 or mis-pair
  const j1 = (recorder.getRequests() as unknown[]).length
  const f1 = recorder.getFixtureCount()
  await call("second")
  const burst2 = recorder.getRecordingsSince(j1, f1)
  expect(burst2).toHaveLength(1)
  expect(burst2[0]?.response).toMatchObject({ content: "TWO" })
  expect(burst2[0]?.request.messages?.[0]).toEqual({ role: "user", content: "second" })
}, 30_000)

it("getRecordings() captures a proxied response from a local upstream", async () => {
  const upstream = await createAimock({
    fixtures: [{ match: {}, response: { content: "from upstream" } }],
  })
  const recorder = await createAimock({
    fixtures: [],
    proxy: { openai: upstream.baseUrl.replace(/\/v1$/, "") },
    record: true,
  })
  afterAll(async () => {
    await recorder.close()
    await upstream.close()
  })

  const res = await fetch(`${recorder.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "ping" }] }),
  })
  expect(res.ok).toBe(true)

  const recordings = recorder.getRecordings()
  expect(recordings).toHaveLength(1)
  expect(recordings[0]?.response).toMatchObject({ content: "from upstream" })
  // aimock >= 1.40 keeps the upstream's token usage on the recorded fixture, so a
  // replay reports the recorded counts rather than a length-based estimate.
  expect(recordings[0]?.response).toHaveProperty("usage")
  expect(recordings[0]?.request.messages?.[0]).toEqual({ role: "user", content: "ping" })
}, 30_000)

it("pairs each recorded response with its own request when they complete out of order (#937)", () => {
  const request = (content: string) => ({ messages: [{ role: "user", content }] })
  const fixture = (userMessage: string, content: string) => ({
    match: { userMessage, turnIndex: 0, hasToolResult: false },
    response: { content },
  })
  // Journal order: alpha, beta. Recording order: beta finished first.
  const recordings = pairRecordings(
    [fixture("beta", "B"), fixture("alpha", "A")],
    [request("alpha"), request("beta")],
  )
  expect(recordings.map((r) => [r.request.messages?.[0]?.content, r.response])).toEqual([
    ["beta", { content: "B" }],
    ["alpha", { content: "A" }],
  ])
  expect(() => pairRecordings([fixture("gamma", "G")], [request("alpha")])).toThrow(
    /matches no proxied request/,
  )
})

it("settled() waits for a call the client has read to the end but aimock has not recorded yet (#937)", async () => {
  // aimock relays the stream as it arrives and records the call only when the
  // upstream response ends. This upstream sends [DONE], then holds the response
  // open, so the client is finished well before the call is recorded.
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "c",
      object: "chat.completion.chunk",
      created: 0,
      model: "gpt-5-mini",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  const upstream = createServer((req, res) => {
    req.resume()
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(chunk({ role: "assistant", content: "late" }, null))
      res.write(chunk({}, "stop"))
      res.write("data: [DONE]\n\n")
      setTimeout(() => res.end(), 1000)
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const recorder = await createAimock({
    fixtures: [],
    proxy: { openai: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` },
    record: true,
  })
  try {
    const response = await fetch(`${recorder.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-5-mini",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let text = ""
    while (!text.includes("[DONE]")) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value)
    }
    await recorder.settled()
    const recordings = recorder.getRecordingsSince(0, 0)
    expect(recordings).toHaveLength(1)
    expect(recordings[0]?.response).toMatchObject({ content: "late" })
    await reader.cancel()
  } finally {
    await recorder.close()
    await new Promise((resolve) => upstream.close(resolve))
  }
}, 30_000)
