import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { createAimock } from "../../testing/dist/aimock-runner.js"
import { script } from "../../testing/dist/fixture-builder.js"
import { createRuntimeRequestListener } from "../src/lib/dev/runtime-server.ts"

const require = createRequire(new URL("../../langchain/package.json", import.meta.url))
const esmPath = (name: string) => require.resolve(name).replace(/\.cjs$/, ".js")
type Event = Record<string, unknown>

function parseSseEvents(text: string): Event[] {
  return text.split("\n\n").flatMap((frame) => {
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length)
    return data ? [JSON.parse(data) as Event] : []
  })
}

function messageTexts(events: Event[]): string[] {
  const messages = new Map<string, string>()
  for (const event of events) {
    if (event.type !== "TEXT_MESSAGE_CONTENT") continue
    const id = String(event.messageId)
    messages.set(id, (messages.get(id) ?? "") + String(event.delta))
  }
  return [...messages.values()]
}

test("frames parallel tool model JSON independently across HTTP approval and resume", async () => {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-agui-model-framing-"))
  const previousBaseUrl = process.env.OPENAI_BASE_URL
  const previousKey = process.env.OPENAI_API_KEY
  let aimock: Awaited<ReturnType<typeof createAimock>> | undefined
  let runtime: Awaited<ReturnType<typeof createRuntimeRequestListener>> | undefined
  let server: Server | undefined

  try {
    const fixtures = script()
      .user("Review records")
      .callsTool("prepareReview", { recordId: "record-1" })
      .callsTool("applyReview", { recordId: "record-1" })
      .replies("Applied.")
      .build()
    const firstFixture = fixtures[0]
    if (!firstFixture || !("toolCalls" in firstFixture.response)) {
      throw new Error("Expected the first fixture to call prepareReview")
    }
    const parallelFixtures = [
      {
        ...firstFixture,
        response: {
          toolCalls: [
            ...firstFixture.response.toolCalls,
            { id: "second-review", name: "prepareReview", arguments: { recordId: "record-2" } },
          ],
        },
      },
      ...fixtures.slice(1),
    ]
    aimock = await createAimock({ fixtures: parallelFixtures })
    process.env.OPENAI_BASE_URL = aimock.baseUrl
    process.env.OPENAI_API_KEY = "test-not-used"
    const files: Record<string, string> = {
      "b4.config.ts": "export default {}\n",
      "package.json": '{ "name": "model-framing-fixture", "type": "module" }\n',
      "src/app/review/index.ts": `
import { agent } from "@b4run/sdk"
export default agent({
  model: "gpt-5-mini",
  systemPrompt: "Review records using tools.",
  tools: { approve: ["applyReview"] },
})
`,
      // Both first chunks must be consumed before either model emits its suffix.
      // This guarantees overlapping model streams without timer-based ordering.
      "src/parallel-model.ts": `
import { FakeStreamingChatModel } from ${JSON.stringify(esmPath("@langchain/core/utils/testing"))}
let arrived = 0
let release: () => void
const bothStarted = new Promise<void>((resolve) => { release = resolve })
export class ParallelModel extends FakeStreamingChatModel {
  async *_streamResponseChunks(...args: Parameters<FakeStreamingChatModel["_streamResponseChunks"]>) {
    let index = 0
    for await (const chunk of super._streamResponseChunks(...args)) {
      if (index++ === 1) {
        if (++arrived === 2) release()
        await bothStarted
      }
      yield chunk
    }
  }
}
`,
      "src/app/review/tools/prepareReview.ts": `
import { ParallelModel } from "../../../parallel-model.js"
import { AIMessageChunk } from ${JSON.stringify(esmPath("@langchain/core/messages"))}
/** Prepare a record review. */
export default async function prepareReview(input: { recordId: string }): Promise<string> {
  const model = new ParallelModel({ chunks: [
    new AIMessageChunk('{"recordId":'),
    new AIMessageChunk(JSON.stringify(input.recordId) + '}'),
  ] })
  const result = await model.invoke("Return a record reference.")
  JSON.parse(result.content as string)
  return "Prepared record-1"
}
`,
      "src/app/review/tools/applyReview.ts": `
/** Apply an approved record review. */
export default async function applyReview(input: { recordId: string }): Promise<string> {
  return "Applied " + input.recordId
}
`,
    }
    for (const [relativePath, body] of Object.entries(files)) {
      const path = join(appRoot, relativePath)
      await mkdir(join(path, ".."), { recursive: true })
      await writeFile(path, body, "utf8")
    }
    await symlink(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      join(appRoot, "node_modules"),
      "dir",
    )
    runtime = await createRuntimeRequestListener({ appRoot })
    server = createServer(runtime.listener)
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo
    const postRun = async (runId: string, extra: Record<string, unknown> = {}) => {
      const response = await fetch(
        `http://127.0.0.1:${port}/agui/${encodeURIComponent("/review#agent")}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify({
            threadId: "parallel-model-framing",
            runId,
            state: {},
            tools: [],
            context: [],
            forwardedProps: {},
            messages: [{ id: "user-1", role: "user", content: "Review records" }],
            ...extra,
          }),
          signal: AbortSignal.timeout(30_000),
        },
      )
      const body = await response.text()
      expect(response.status, body).toBe(200)
      return parseSseEvents(body)
    }

    const first = await postRun("first")
    expect(first.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "interrupt" } })
    const outcome = first.at(-1)?.outcome as { interrupts: Array<{ id: string }> }
    expect(outcome.interrupts).toHaveLength(1)
    const resumed = await postRun("resumed", {
      messages: [],
      resume: outcome.interrupts.map(({ id }) => ({
        interruptId: id,
        status: "resolved",
        payload: "once",
      })),
    })

    expect(resumed.at(-1)).toMatchObject({ type: "RUN_FINISHED", outcome: { type: "success" } })
    expect(messageTexts(resumed)).toEqual(["Applied."])
    expect(aimock.getRequests()).toHaveLength(3)
    const texts = messageTexts(first)
    expect(texts).toHaveLength(2)
    expect(texts.map((text) => JSON.parse(text))).toEqual(
      expect.arrayContaining([{ recordId: "record-1" }, { recordId: "record-2" }]),
    )
    const starts = first.filter(({ type }) => type === "TEXT_MESSAGE_START")
    expect(starts).toHaveLength(2)
    expect(new Set(starts.map(({ messageId }) => messageId)).size).toBe(2)
    expect(first.filter(({ type }) => type === "TEXT_MESSAGE_END")).toHaveLength(2)
    for (const start of starts) {
      const lifecycle = first.filter(({ messageId }) => messageId === start.messageId)
      expect(lifecycle.map(({ type }) => type)).toEqual([
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
      ])
    }
  } finally {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
    await runtime?.close()
    await aimock?.close()
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = previousBaseUrl
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    await rm(appRoot, { recursive: true, force: true })
  }
}, 60_000)
