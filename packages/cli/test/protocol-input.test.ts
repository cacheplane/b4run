import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  normalizeProtocolInput,
  normalizeProtocolOutput,
  type ProtocolBoundaryOptions,
} from "../src/lib/dev/protocol/input.ts"
import { mergePublicMessages } from "../src/lib/dev/protocol/messages.ts"
import {
  executeResolvedRoute,
  invokeResolvedRoute,
  streamResolvedRoute,
} from "../src/lib/runtime/execute-route.ts"
import { toAgentInput } from "../src/lib/runtime/execute-route-core.ts"
import { normalizeServerResult } from "../src/lib/runtime/normalize-server-result.ts"

const first = { role: "user" as const, id: "first", content: "top-level" }
const second = {
  role: "assistant" as const,
  id: "second",
  content: [{ type: "reasoning", text: "kept" }],
}
const adapter = { parseInput: (input: unknown) => input, messages: { reduce: mergePublicMessages } }
const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("protocol route input", () => {
  it.each([0, false, "", "question", null, [1, 2]])(
    "preserves opaque business input %# and checks its route schema",
    (input) => {
      let checked: unknown
      expect(
        normalizeProtocolInput(input, {
          adapter: {
            parseInput: (value) => {
              checked = value
              return value
            },
          },
        }),
      ).toBe(input)
      expect(checked).toBe(input)
    },
  )

  it("leaves business objects opaque without a declared message adapter", () => {
    const input = {
      messages: "business field",
      route: "business",
      resume: { task: "business" },
      lc: 1,
      id: ["AIMessage"],
      kwargs: { content: "opaque business data" },
    }
    expect(normalizeProtocolInput(input, { adapter: { parseInput: (value) => value } })).toBe(input)
  })

  it("combines top-level messages before input.messages through the declared reducer then validates complete input", () => {
    const calls: unknown[] = []
    const result = normalizeProtocolInput(
      { topic: "business", messages: [second] },
      {
        messages: [first],
        adapter: {
          parseInput: (input) => {
            calls.push(input)
            return input
          },
          messages: {
            reduce: (left, right) => {
              calls.push([left, right])
              return mergePublicMessages(left, right)
            },
          },
        },
      },
    )
    expect(calls).toEqual([[[first], [second]], { topic: "business", messages: [first, second] }])
    expect(result).toEqual({ topic: "business", messages: [first, second] })
  })

  it("deduplicates matching IDs and rejects conflicting IDs before reducer execution", () => {
    expect(normalizeProtocolInput({ messages: [first] }, { messages: [first], adapter })).toEqual({
      messages: [first],
    })
    expect(() =>
      normalizeProtocolInput(
        { messages: [{ ...first, content: "conflict" }] },
        { messages: [first], adapter },
      ),
    ).toThrow(/conflicting/i)
  })

  it("rejects messages without declared capability even when empty", () => {
    expect(() =>
      normalizeProtocolInput({}, { messages: [], adapter: { parseInput: (v) => v } }),
    ).toThrow(/route.input/i)
  })

  it.each([0, false, null, "hello", []])(
    "rejects unsupported non-object input plus messages %# without dropping either",
    (input) => {
      expect(() => normalizeProtocolInput(input, { messages: [first], adapter })).toThrow(
        /route.input/i,
      )
    },
  )

  it("accepts scalar plus messages only through the adapter's explicit combination and schema", () => {
    expect(
      normalizeProtocolInput("question", {
        messages: [first],
        adapter: {
          parseInput: (value) => {
            expect(value).toEqual({ question: "question", messages: [first] })
            return value
          },
          messages: {
            reduce: mergePublicMessages,
            combineInput: (input, messages) => ({ question: input, messages }),
          },
        },
      }),
    ).toEqual({ question: "question", messages: [first] })
  })

  it("treats missing input differently from explicit null", () => {
    expect(normalizeProtocolInput(undefined, { messages: [first], adapter })).toEqual({
      messages: [first],
    })
    expect(() => normalizeProtocolInput(null, { messages: [first], adapter })).toThrow(
      /route.input/i,
    )
  })

  it("runs the declared guard and rejects invalid message arrays", () => {
    expect(() => normalizeProtocolInput({ messages: "invalid" }, { adapter })).toThrow(/message/i)
    expect(() =>
      normalizeProtocolInput(
        { messages: [first] },
        {
          adapter: {
            ...adapter,
            parseInput: () => {
              throw new Error("topic required")
            },
          },
        },
      ),
    ).toThrow(/route.input.*topic required/i)
  })

  it("never treats old route or resume request keys as aliases", () => {
    expect(normalizeProtocolInput(undefined, { adapter })).toBeUndefined()
    const input = { route: "old", resume: { stale: "once" } }
    expect(normalizeProtocolInput(input, { adapter })).toBe(input)
    expect(toAgentInput(input)).toBe(input)
    expect(toAgentInput(input, { interrupt: "once" })).toHaveProperty("resume", {
      interrupt: "once",
    })
  })
})

describe("protocol route output", () => {
  it.each([0, false, "", "answer", null, [1, 2]])(
    "wraps scalar or array output %# without loss",
    (output) => {
      expect(normalizeProtocolOutput(output)).toEqual({ values: { output } })
    },
  )

  it("retains state objects and removes duplicate messages only when returning top-level messages", () => {
    const state = { answer: 42, messages: [second] }
    expect(normalizeProtocolOutput(state)).toEqual({ values: state })
    expect(normalizeProtocolOutput(state, { messages: true })).toEqual({
      values: { answer: 42 },
      messages: [second],
    })
    expect(state).toHaveProperty("messages")
  })

  it("projects serialized LangChain messages in public output", () => {
    expect(
      normalizeProtocolOutput(
        {
          messages: [
            {
              lc: 1,
              type: "constructor",
              id: ["langchain_core", "messages", "AIMessage"],
              kwargs: { id: "reply", content: second.content },
            },
          ],
        },
        { messages: true },
      ),
    ).toEqual({
      values: {},
      messages: [{ id: "reply", role: "assistant", content: second.content }],
    })
  })

  it("serializes an absent route return as an explicit null output", () => {
    expect(JSON.parse(JSON.stringify(normalizeProtocolOutput(undefined)))).toEqual({
      values: { output: null },
    })
  })

  it("normalizes declared messages retained inside values when top-level projection is disabled", () => {
    const message = {
      lc: 1,
      type: "constructor",
      id: ["langchain_core", "messages", "AIMessage"],
      kwargs: { id: "answer", content: "done" },
    }
    expect(
      normalizeProtocolOutput({ messages: [message], task: "kept" }, { messages: false }),
    ).toEqual({
      values: { messages: [{ id: "answer", role: "assistant", content: "done" }], task: "kept" },
    })
  })

  it("requires declared stateful output to be a state object", () => {
    expect(() => normalizeProtocolOutput(0, { stateful: true })).toThrow(/state object/)
  })

  it("keeps legacy server response semantics while providing an explicit protocol conversion", () => {
    const options = {
      appRoot: "/fixture",
      mode: "workflow" as const,
      routeId: "/echo",
      routePath: "src/app/echo/index.ts",
      responseBodyText: "0",
      startedAt: 0,
      statusCode: 200,
    }
    expect(normalizeServerResult(options)).toMatchObject({ status: "passed", output: 0 })
    expect(normalizeServerResult({ ...options, protocol: {} })).toMatchObject({
      status: "passed",
      output: { values: { output: 0 } },
    })
  })
})

async function fixture(kind: "workflow" | "graph" = "workflow") {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-protocol-input-"))
  cleanup.push(appRoot)
  const routeFile = join(appRoot, "src/app/echo/index.ts")
  await mkdir(join(routeFile, ".."), { recursive: true })
  await writeFile(join(appRoot, "b4.config.ts"), "export default {}\n")
  await writeFile(join(appRoot, "package.json"), '{"type":"module"}')
  await writeFile(routeFile, `export const ${kind} = (input) => input\n`)
  return { appRoot, routeFile, routeId: "/echo", routePath: "src/app/echo/index.ts" }
}

describe("execution adapter protocol integration", () => {
  it.each([executeResolvedRoute, invokeResolvedRoute])(
    "normalizes complete input/output through the resolved route adapter %#",
    async (execute) => {
      const options = await fixture()
      const protocol: ProtocolBoundaryOptions = {
        messages: [first],
        adapter,
        output: { messages: true, stateful: true },
      }
      const result = await execute({
        ...options,
        input: { question: "hello", messages: [second] },
        protocol,
      })
      expect(result).toMatchObject({
        status: "passed",
        output: { values: { question: "hello" }, messages: [first, second] },
      })
    },
  )

  it("keeps graph business input opaque while enforcing its declared route schema", async () => {
    const options = await fixture("graph")
    const input = { messages: "business", lc: 1, id: ["AIMessage"], kwargs: { amount: 3 } }
    const result = await invokeResolvedRoute({
      ...options,
      input,
      protocol: {
        adapter: {
          parseInput: (value) => {
            expect(value).toBe(input)
            return value
          },
        },
      },
    })
    expect(result).toMatchObject({ status: "passed", output: { values: input } })
  })

  it("normalizes non-agent streaming completion using the same boundary", async () => {
    const options = await fixture()
    const chunks = []
    for await (const chunk of streamResolvedRoute({
      ...options,
      input: 0,
      protocol: { adapter: { parseInput: (value) => value } },
    }))
      chunks.push(chunk)
    expect(chunks).toEqual([{ type: "done", output: { values: { output: 0 } } }])
  })

  it("rejects route input before entry executes and preserves unconfigured native output", async () => {
    const options = await fixture()
    const native = await invokeResolvedRoute({ ...options, input: false })
    expect(native).toMatchObject({ status: "passed", output: false })
    const result = await invokeResolvedRoute({
      ...options,
      input: "bad",
      protocol: {
        adapter: {
          parseInput: () => {
            throw new Error("must be object")
          },
        },
      },
    })
    expect(result).toMatchObject({
      status: "failed",
      error: { message: expect.stringMatching(/route.input.*must be object/i) },
    })
  })
})
