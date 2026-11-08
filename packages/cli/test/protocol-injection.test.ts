import { streamAgent } from "@b4run/langchain"
import { agent } from "@b4run/sdk"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { MemorySaver } from "@langchain/langgraph"
import { afterEach, expect, it, vi } from "vitest"
import { body, fixture } from "./fixtures/protocol-admission.ts"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.doUnmock("@langchain/openai")
})

it("ordinary receipt lookup and Run search serialize binding with concurrent transactions", async () => {
  const f = await fixture()
  cleanup.push(() => f.close())
  const accepted = await f.admit(body({ on_completion: "keep" }))
  const store = await f.store(accepted.threadId)
  const other = await f.admit(
    body({ on_completion: "keep", metadata: { b4: { v: 1, submissionId: crypto.randomUUID() } } }),
  )
  for (const target of [accepted.threadId, other.threadId]) {
    for (let microtasks = 0; microtasks < 5; microtasks++) {
      let release!: () => void, entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      const writer = store.transaction(async () => {
        entered()
        await barrier
      })
      for (let turn = 0; turn < microtasks; turn++) await Promise.resolve()
      const binding = f.store(target)
      const result = Promise.allSettled([binding])
      await started
      release()
      await writer
      const outcome = (await result)[0]
      if (outcome?.status === "rejected") throw outcome.reason
      expect(outcome?.status).toBe("fulfilled")
    }
  }
  await expect(store.transaction(() => f.store(other.threadId))).rejects.toThrow(
    f.native.workerBoot
      ? /^Nested runtime host access would deadlock$/
      : /Nested runtime transaction/,
  )
  await expect(store.withReadLease(() => f.store(accepted.threadId))).rejects.toThrow(
    /Nested runtime transaction or lease/,
  )
  const outcomes = await Promise.allSettled([
    f.lookup(),
    f.search({}, { thread_id: accepted.threadId }),
    f.admit(body({ on_completion: "keep" })),
    f.lookup(),
    f.search({}, { thread_id: accepted.threadId }),
  ])
  expect(outcomes.map((value) => value.status)).toEqual(Array(5).fill("fulfilled"))
  for (const result of outcomes)
    if (result.status === "fulfilled" && Array.isArray(result.value))
      expect(result.value[0]?.run_id).toBe(accepted.runId)
}, 30_000)

it("the real built-in model consumes active input only at its next eligible step", async () => {
  const seen: string[][] = []
  let active = 0,
    maximum = 0
  class ControlledModel extends BaseChatModel {
    constructor(_options: Record<string, unknown>) {
      super({})
    }
    _llmType() {
      return "controlled-local"
    }
    bindTools() {
      return this
    }
    async _generate(messages: BaseMessage[]): Promise<ChatResult> {
      maximum = Math.max(maximum, ++active)
      seen.push(messages.map((message) => String(message.content)))
      const message =
        seen.length === 1
          ? new AIMessage({
              content: "",
              tool_calls: [{ id: "inspect-1", name: "inspect", args: {} }],
            })
          : new AIMessage("done")
      active--
      return { generations: [{ text: "", message }] }
    }
  }
  vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ControlledModel }))
  let queued = false,
    drains = 0
  const options = {
    checkpointer: new MemorySaver(),
    entry: agent({ model: "gpt-5-mini", systemPrompt: "Controlled." }),
    input: { messages: [{ role: "user", content: "initial" }] },
    routeParamNames: [],
    signal: new AbortController().signal,
    threadId: "active-boundary",
    tools: [
      {
        name: "inspect",
        description: "Inspect.",
        run: async () => {
          queued = true
          return "observed"
        },
      },
    ],
    activeInput: {
      async beforeModel() {
        drains++
        return queued
          ? {
              messages: [{ id: "injected-1", role: "user" as const, content: "steer next step" }],
              inputIds: ["injected-1"],
            }
          : undefined
      },
    },
  }
  for await (const _chunk of streamAgent(options)) {
    /* await actual graph unwind */
  }
  expect(seen).toHaveLength(2)
  expect(seen[0]).not.toContain("steer next step")
  expect(seen[1]).toContain("steer next step")
  expect(drains).toBe(2)
  expect(maximum).toBe(1)
}, 30_000)
