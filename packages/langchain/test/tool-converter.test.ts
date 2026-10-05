import type { StreamTransformerInput } from "@b4run/core"
import { B4_STEP_KEY, CLIENT_TOOL_RECORDER_KEY, toolDenial } from "@b4run/sdk"
import { ToolMessage } from "@langchain/core/messages"
import { type Command, GraphInterrupt, isCommand } from "@langchain/langgraph"
import { beforeEach, describe, expect, it, test, vi } from "vitest"
import { convertToolToLangChain, jsonSchemaToZod } from "../src/tool-converter.ts"

const dispatchCustomEvent = vi.hoisted(() => vi.fn())

vi.mock("@langchain/core/callbacks/dispatch/web", () => ({ dispatchCustomEvent }))

beforeEach(() => {
  dispatchCustomEvent.mockReset()
})

describe("convertToolToLangChain", () => {
  test("dispatches every transformer output as a capability event with the live config", async () => {
    const order: string[] = []
    const config = {
      configurable: { thread_id: "thread-1" },
      signal: new AbortController().signal,
      toolCall: { id: "provider-call-1" },
    }
    // A distinguishing property (not just `{}`) so `objectContaining({ callbacks: childCallbacks })`
    // actually proves the DISPATCHED config is the patched one carrying this exact
    // object, rather than being trivially satisfied by any empty object.
    const childCallbacks = { handlers: [] }
    const runManager = { runId: "execution-run-1", getChild: vi.fn(() => childCallbacks) }
    let transformerInput: StreamTransformerInput | undefined
    dispatchCustomEvent.mockImplementation(async (_name, payload) => {
      order.push(`dispatch:${payload.event}`)
    })
    const converted = convertToolToLangChain(
      {
        name: "probe",
        run: async () => {
          order.push("run")
          return { ok: true }
        },
      },
      undefined,
      undefined,
      [],
      [
        {
          observes: "tool_result",
          transform: async function* (input) {
            transformerInput = input
            order.push("transform:first")
            yield { event: "first", data: { index: 1 } }
            order.push("transform:second")
            yield { event: "second", data: { index: 2 } }
          },
        },
      ],
    )

    await converted.func({}, runManager as never, config as never)
    order.push("returned")

    // patchConfig's ensureConfig() injects harmless defaults (tags, metadata,
    // recursionLimit, runId) onto the live config once a runManager is present,
    // so match on the live-config fields we actually care about rather than
    // exact identity with the raw `config` object.
    expect(dispatchCustomEvent).toHaveBeenNthCalledWith(
      1,
      "b4.capability",
      { event: "first", data: { index: 1 } },
      expect.objectContaining({
        configurable: config.configurable,
        signal: config.signal,
        toolCall: config.toolCall,
        callbacks: childCallbacks,
      }),
    )
    expect(dispatchCustomEvent).toHaveBeenNthCalledWith(
      2,
      "b4.capability",
      { event: "second", data: { index: 2 } },
      expect.objectContaining({
        configurable: config.configurable,
        signal: config.signal,
        toolCall: config.toolCall,
        callbacks: childCallbacks,
      }),
    )
    // Both dispatches must see the exact same patched live-config object.
    expect(dispatchCustomEvent.mock.calls[0]?.[2]).toBe(dispatchCustomEvent.mock.calls[1]?.[2])
    expect(order).toEqual([
      "run",
      "transform:first",
      "dispatch:first",
      "transform:second",
      "dispatch:second",
      "returned",
    ])
    // The transformer sees the ToolMessage the tool node will store, as it
    // always has for a displayed tool.
    expect(transformerInput).toEqual({
      toolName: "probe",
      toolOutput: expect.any(ToolMessage),
      toolCallId: "provider-call-1",
    })
    expect((transformerInput as { toolOutput: ToolMessage }).toolOutput.content).toBe(
      JSON.stringify({ ok: true }),
    )
    expect(transformerInput?.toolCallId).not.toBe("execution-run-1")
  })

  test("omits the transformer tool-call id when the config carries none", async () => {
    let transformerInput: StreamTransformerInput | undefined
    const converted = convertToolToLangChain(
      { name: "probe", run: async () => "ok" },
      undefined,
      undefined,
      [],
      [
        {
          observes: "tool_result",
          // biome-ignore lint/correctness/useYield: captures the transform input; this transformer emits no events
          transform: async function* (input) {
            transformerInput = input
          },
        },
      ],
    )

    await converted.func({}, undefined as never, { signal: new AbortController().signal } as never)

    expect(transformerInput).toBeDefined()
    expect(Object.hasOwn(transformerInput ?? {}, "toolCallId")).toBe(false)
  })

  test("omits the transformer tool-call id when the config carries an empty-string id", async () => {
    let transformerInput: StreamTransformerInput | undefined
    const converted = convertToolToLangChain(
      { name: "probe", run: async () => "ok" },
      undefined,
      undefined,
      [],
      [
        {
          observes: "tool_result",
          // biome-ignore lint/correctness/useYield: captures the transform input; this transformer emits no events
          transform: async function* (input) {
            transformerInput = input
          },
        },
      ],
    )

    await converted.func(
      {},
      undefined as never,
      { signal: new AbortController().signal, toolCall: { id: "" } } as never,
    )

    expect(transformerInput).toBeDefined()
    expect(Object.hasOwn(transformerInput ?? {}, "toolCallId")).toBe(false)
  })

  test("transforms and dispatches a Command result before returning it", async () => {
    const config = { configurable: { thread_id: "thread-2" } }
    const converted = convertToolToLangChain(
      {
        name: "writeState",
        run: async () => ({ result: { ok: true }, state: { value: 42 } }),
      },
      undefined,
      undefined,
      [],
      [
        {
          observes: "tool_result",
          transform: async function* ({ toolOutput }) {
            expect(isCommand(toolOutput)).toBe(true)
            yield { event: "state_update", data: { value: 42 } }
          },
        },
      ],
    )

    const result = await converted.func({}, undefined as never, config as never)

    expect(isCommand(result)).toBe(true)
    expect(dispatchCustomEvent).toHaveBeenCalledWith(
      "b4.capability",
      { event: "state_update", data: { value: 42 } },
      config,
    )
  })

  test("returns the tool's content when a transformer iterator fails", async () => {
    const converted = convertToolToLangChain(
      { name: "probe", run: async () => "ok" },
      undefined,
      undefined,
      [],
      [
        {
          observes: "tool_result",
          transform: async function* () {
            yield { event: "before_failure", data: null }
            throw new Error("transform failed")
          },
        },
      ],
    )

    const result = (await converted.func(
      {},
      undefined as never,
      {
        signal: new AbortController().signal,
      } as never,
    )) as ToolMessage
    expect(result).toBeInstanceOf(ToolMessage)
    expect(result.content).toBe(JSON.stringify("ok"))
  })

  test("returns a state-updating Command when capability dispatch fails", async () => {
    dispatchCustomEvent.mockRejectedValue(new Error("dispatch failed"))
    const converted = convertToolToLangChain(
      {
        name: "writeState",
        run: async () => ({ result: "updated", state: { value: 42 } }),
      },
      undefined,
      undefined,
      [],
      [
        {
          observes: "tool_result",
          transform: async function* () {
            yield { event: "state_update", data: { value: 42 } }
          },
        },
      ],
    )

    const result = await converted.func(
      {},
      undefined as never,
      { signal: new AbortController().signal } as never,
    )

    expect(isCommand(result)).toBe(true)
    expect((result as InstanceType<typeof Command>).update).toMatchObject({ value: 42 })
  })

  test("converts a basic B4.run tool to a DynamicStructuredTool", async () => {
    const b4Tool = {
      name: "greet",
      description: "Greet a user",
      filePath: "/app/tools/greet.ts",
      run: async (input: unknown) => ({ greeting: `Hello, ${(input as { name: string }).name}!` }),
      scope: "shared" as const,
    }

    const langchainTool = convertToolToLangChain(b4Tool)

    expect(langchainTool.name).toBe("greet")
    expect(langchainTool.description).toBe("Greet a user")
    const result = (await langchainTool.invoke({ name: "World" })) as ToolMessage
    expect(result).toBeInstanceOf(ToolMessage)
    expect(result.content).toBe(JSON.stringify({ greeting: "Hello, World!" }))
  })

  test("marks the LangChain tool returnDirect when the definition asks for it", () => {
    const direct = convertToolToLangChain({
      name: "render",
      returnDirect: true,
      run: async () => ({ rendered: true }),
    })
    const ordinary = convertToolToLangChain({
      name: "lookup",
      run: async () => ({ ok: true }),
    })

    expect(direct.returnDirect).toBe(true)
    expect(ordinary.returnDirect).toBe(false)
  })

  test("uses empty description when none provided", () => {
    const b4Tool = {
      name: "ping",
      filePath: "/app/tools/ping.ts",
      run: async () => ({ pong: true }),
      scope: "shared" as const,
    }

    const langchainTool = convertToolToLangChain(b4Tool)

    expect(langchainTool.name).toBe("ping")
    expect(langchainTool.description).toBe("")
  })

  test("converts JSON Schema from tools.json to Zod schema", async () => {
    const b4Tool = {
      name: "greet",
      description: "Greet a tenant",
      filePath: "/app/tools/greet.ts",
      run: async (input: unknown) => input,
      schema: {
        type: "object",
        properties: {
          tenant: { type: "string" },
        },
        required: ["tenant"],
        additionalProperties: false,
      },
      scope: "shared" as const,
    }

    const langchainTool = convertToolToLangChain(b4Tool)

    expect(langchainTool.name).toBe("greet")
    const result = (await langchainTool.invoke({ tenant: "acme" })) as ToolMessage
    expect(JSON.parse(String(result.content))).toEqual({ tenant: "acme" })
  })

  test("uses provided Zod schema when available", async () => {
    const { z } = await import("zod")
    const schema = z.object({ id: z.string().describe("Customer ID") })

    const b4Tool = {
      name: "lookup",
      description: "Look up customer",
      run: async (input: unknown) => input,
      schema,
      scope: "shared" as const,
    }

    const langchainTool = convertToolToLangChain(b4Tool)

    expect(langchainTool.schema).toBe(schema)
  })
})

describe("convertToolToLangChain — {result, state} wrapped returns", () => {
  it("returns a ToolMessage whose content is the JSON-stringified plain return", async () => {
    const tool = {
      name: "echo",
      description: "Echo input.",
      run: async (input: unknown) => input,
    }
    const converted = convertToolToLangChain(tool)
    const result = await converted.func(
      { msg: "hi" },
      undefined as unknown as never,
      { signal: new AbortController().signal } as unknown as never,
    )
    expect(result).toBeInstanceOf(ToolMessage)
    expect((result as ToolMessage).content).toBe(JSON.stringify({ msg: "hi" }))
  })

  it("returns a Command when the tool returns {result, state}", async () => {
    const tool = {
      name: "writeFoo",
      description: "Write foo to state.",
      run: async () => ({ result: { ok: true }, state: { foo: 42 } }),
    }
    const converted = convertToolToLangChain(tool)
    const result = await converted.func(
      {},
      undefined as unknown as never,
      { signal: new AbortController().signal } as unknown as never,
    )
    expect(isCommand(result)).toBe(true)
    const cmd = result as InstanceType<typeof Command>
    const update = cmd.update as Record<string, unknown>
    expect(update.foo).toBe(42)
  })

  it("returns a Command whose embedded ToolMessage content is the verbatim string when result is a string", async () => {
    const tool = {
      name: "writeNote",
      description: "Write note + state",
      run: async () => ({ result: "noted", state: { note: "noted" } }),
    }
    const converted = convertToolToLangChain(tool)
    const result = await converted.func(
      {},
      undefined as unknown as never,
      { signal: new AbortController().signal } as unknown as never,
    )
    expect(isCommand(result)).toBe(true)
    const cmd = result as InstanceType<typeof Command>
    const update = cmd.update as Record<string, unknown> & { messages?: unknown[] }
    expect(Array.isArray(update.messages)).toBe(true)
    const msg = (update.messages as Array<{ content?: unknown }>)[0]
    expect(msg?.content).toBe("noted")
    expect(update.note).toBe("noted")
  })

  it("returns a ToolMessage with the plain string content when tool returns { result } only (no state)", async () => {
    const tool = {
      name: "noState",
      description: "...",
      run: async () => ({ result: "ok" }),
    }
    const converted = convertToolToLangChain(tool)
    const result = await converted.func(
      {},
      undefined as unknown as never,
      { signal: new AbortController().signal } as unknown as never,
    )
    expect(result).toBeInstanceOf(ToolMessage)
    expect((result as ToolMessage).content).toBe("ok")
  })
})

describe("convertToolToLangChain — config.configurable forwarding", () => {
  it.each([undefined, "runtime-thread"])(
    "does not use model arguments as thread identity when runtime identity is %s",
    async (threadId) => {
      let seen: { threadId?: string } | undefined
      let observedInput: unknown
      const converted = convertToolToLangChain({
        name: "identityProbe",
        schema: {
          type: "object",
          properties: { threadId: { type: "string" } },
          required: ["threadId"],
        },
        run: (input: unknown, ctx: { threadId?: string }) => {
          observedInput = input
          seen = ctx
          return "ok"
        },
      })
      await converted.invoke(
        { threadId: "model-supplied-thread" },
        { configurable: threadId === undefined ? {} : { thread_id: threadId } },
      )
      expect(observedInput).toEqual({ threadId: "model-supplied-thread" })
      expect(seen).toBeDefined()
      expect(seen?.threadId).toBe(threadId)
      expect(Object.hasOwn(seen ?? {}, "threadId")).toBe(threadId !== undefined)
    },
  )

  it("forwards thread_id and route params from config.configurable into the tool run context", async () => {
    let seen:
      | { threadId: string | undefined; params: Record<string, string> | undefined }
      | undefined
    const tool = {
      name: "probe",
      run: (_input: unknown, ctx: { threadId?: string; params?: Record<string, string> }) => {
        seen = { threadId: ctx.threadId, params: ctx.params }
        return "ok"
      },
    }
    const lc = convertToolToLangChain(tool, undefined, undefined, ["tenant"])
    await lc.invoke(
      {},
      {
        configurable: {
          thread_id: "t-123",
          tenant: "acme",
          checkpoint_ns: "tools:xyz",
          __pregel_task_id: "abc",
        },
      },
    )
    expect(seen?.threadId).toBe("t-123")
    // ONLY the allowlisted route param — LangGraph internals like checkpoint_ns
    // and __pregel_task_id must NOT leak into ctx.params.
    expect(seen?.params).toEqual({ tenant: "acme" })
  })
})

describe("jsonSchemaToZod nesting", () => {
  it("accepts null without widening nullable fields or making them optional", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        value: { anyOf: [{ type: "string" }, { type: "null" }] },
        optional: { anyOf: [{ type: "number" }, { type: "null" }] },
        missing: { type: "null" },
      },
      required: ["value", "missing"],
      additionalProperties: false,
    })

    expect(schema.parse({ value: null, missing: null })).toEqual({ value: null, missing: null })
    expect(schema.parse({ value: "known", optional: 1, missing: null })).toEqual({
      value: "known",
      optional: 1,
      missing: null,
    })
    expect(schema.safeParse({ value: null, optional: null, missing: null }).success).toBe(true)
    for (const value of [42, false, {}, [], undefined]) {
      expect(schema.safeParse({ value, missing: null }).success).toBe(false)
    }
    expect(schema.safeParse({ missing: null }).success).toBe(false)
    expect(schema.safeParse({ value: null }).success).toBe(false)
    expect(schema.safeParse({ value: null, optional: "wrong", missing: null }).success).toBe(false)
    expect(schema.safeParse({ value: null, missing: "wrong" }).success).toBe(false)
  })

  it("builds a nested object schema that validates", () => {
    const zodSchema = jsonSchemaToZod({
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: { status: { type: "string" }, limit: { type: "number" } },
          required: ["status"],
          additionalProperties: false,
        },
      },
      required: ["filter"],
      additionalProperties: false,
    })
    expect(zodSchema.parse({ filter: { status: "open", limit: 5 } })).toEqual({
      filter: { status: "open", limit: 5 },
    })
    expect(() => zodSchema.parse({ filter: { limit: 5 } })).toThrow()
  })

  it("builds an array-of-objects schema", () => {
    const zodSchema = jsonSchemaToZod({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "number" } },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    })
    expect(zodSchema.parse({ items: [{ id: 1 }, { id: 2 }] })).toEqual({
      items: [{ id: 1 }, { id: 2 }],
    })
  })

  it("builds a z.record from additionalProperties schema", () => {
    const zodSchema = jsonSchemaToZod({
      type: "object",
      properties: { meta: { type: "object", additionalProperties: { type: "number" } } },
      required: ["meta"],
      additionalProperties: false,
    })
    expect(zodSchema.parse({ meta: { a: 1, b: 2 } })).toEqual({ meta: { a: 1, b: 2 } })
    expect(() => zodSchema.parse({ meta: { a: "x" } })).toThrow()
  })

  it("builds a z.union from anyOf", () => {
    const zodSchema = jsonSchemaToZod({
      type: "object",
      properties: {
        action: {
          anyOf: [
            {
              type: "object",
              properties: { kind: { type: "string", enum: ["create"] }, name: { type: "string" } },
              required: ["kind", "name"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { kind: { type: "string", enum: ["delete"] }, id: { type: "number" } },
              required: ["kind", "id"],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ["action"],
      additionalProperties: false,
    })
    expect(zodSchema.parse({ action: { kind: "create", name: "x" } })).toEqual({
      action: { kind: "create", name: "x" },
    })
    expect(zodSchema.parse({ action: { kind: "delete", id: 7 } })).toEqual({
      action: { kind: "delete", id: 7 },
    })
    expect(() => zodSchema.parse({ action: { kind: "create" } })).toThrow()
  })
})

describe("convertToolToLangChain offloading", () => {
  it("passes the exact live tool-call signal to offloading", async () => {
    const signal = new AbortController().signal
    const offload = vi.fn(async () => "STUB")
    const converted = convertToolToLangChain(
      { name: "dump", run: async () => "x".repeat(50_000) },
      undefined,
      offload,
    )

    await converted.func(
      {},
      undefined as never,
      {
        signal,
        toolCall: { id: "call-live" },
      } as never,
    )

    expect(offload).toHaveBeenCalledWith(expect.any(String), "dump", "call-live", signal)
  })

  it("replaces large plain-return content with a stub", async () => {
    const big = "x".repeat(50_000)
    const tool = { name: "dump", description: "", run: async () => big }
    const offload = async (content: string, toolName: string) =>
      content.length > 40_000 ? `STUB:${toolName}` : content
    const converted = convertToolToLangChain(tool, undefined, offload)
    const result = await converted.func(
      {},
      undefined as never,
      { signal: new AbortController().signal } as never,
    )
    expect(result).toBeInstanceOf(ToolMessage)
    expect((result as ToolMessage).content).toBe("STUB:dump")
  })
  it("replaces large {result,state} content with a stub in the ToolMessage", async () => {
    const big = "y".repeat(50_000)
    const tool = {
      name: "dump2",
      description: "",
      run: async () => ({ result: big, state: { k: 1 } }),
    }
    const offload = async (content: string) => (content.length > 40_000 ? "STUB2" : content)
    const converted = convertToolToLangChain(tool, undefined, offload)
    const result = await converted.func(
      {},
      undefined as never,
      { signal: new AbortController().signal } as never,
    )
    const cmd = result as { update: { messages: Array<{ content: unknown }>; k?: number } }
    expect(cmd.update.messages[0]?.content).toBe("STUB2")
    expect(cmd.update.k).toBe(1)
  })
  it("is a pass-through when no offload callback is given", async () => {
    const big = "z".repeat(50_000)
    const tool = { name: "dump3", description: "", run: async () => big }
    const converted = convertToolToLangChain(tool)
    const result = await converted.func(
      {},
      undefined as never,
      { signal: new AbortController().signal } as never,
    )
    // unwrapToolResult JSON-stringifies plain values; verify no offload substitution occurred
    expect(result).toBeInstanceOf(ToolMessage)
    expect((result as ToolMessage).content).toBe(JSON.stringify(big))
  })
})

describe("convertToolToLangChain tool-call id in the run context", () => {
  const probe = () => {
    const seen: { ctx?: Record<string, unknown> } = {}
    const tool = convertToolToLangChain({
      name: "probe",
      schema: { type: "object", properties: {} },
      run: async (_input, ctx) => {
        seen.ctx = ctx as Record<string, unknown>
        return { result: "ok" }
      },
    })
    return { seen, tool }
  }

  it("passes the provider tool-call id into run", async () => {
    const { seen, tool } = probe()
    await tool.invoke({ args: {}, id: "call_abc", name: "probe", type: "tool_call" })
    expect(seen.ctx?.toolCallId).toBe("call_abc")
  })

  it("omits toolCallId when invoked outside a model tool call", async () => {
    const { seen, tool } = probe()
    await tool.invoke({})
    expect(seen.ctx).toBeDefined()
    expect("toolCallId" in (seen.ctx ?? {})).toBe(false)
  })
})

describe("convertToolToLangChain — the tool-call record", () => {
  function recorder() {
    const log: string[] = []
    return {
      log,
      recorder: {
        has: vi.fn(async () => false),
        record: vi.fn(async () => {}),
        issue: async (call: { toolCallId: string; toolName: string }) => {
          log.push(`issue:${call.toolName}:${call.toolCallId}`)
        },
        settle: async (toolCallId: string) => {
          log.push(`settle:${toolCallId}`)
        },
      },
    }
  }
  const call = { args: {}, id: "call_1", name: "probe", type: "tool_call" as const }
  const configWith = (rec: unknown) => ({ configurable: { [CLIENT_TOOL_RECORDER_KEY]: rec } })

  it("inside a subagent, records the child's route key and the launching task", async () => {
    const issued: unknown[] = []
    const rec = {
      has: vi.fn(async () => false),
      record: vi.fn(async () => {}),
      issue: async (c: unknown) => {
        issued.push(c)
      },
      settle: async () => {},
    }
    const tool = convertToolToLangChain({
      name: "probe",
      schema: { type: "object", properties: {} },
      run: async () => "ok",
    })
    await tool.invoke(call, {
      ...configWith(rec),
      metadata: {
        b4: {
          subagent_stack: [
            {
              callId: "call_task_1",
              name: "researcher",
              routeId: "/chat/subagents/researcher",
              routeKey: "/chat/subagents/researcher#agent",
            },
          ],
        },
      },
    })
    expect(issued).toStrictEqual([
      {
        toolCallId: "call_1",
        toolName: "probe",
        origin: { routeId: "/chat/subagents/researcher#agent", parentToolCallId: "call_task_1" },
      },
    ])
  })

  it("issues before the tool body and settles after it returns", async () => {
    const { log, recorder: rec } = recorder()
    const tool = convertToolToLangChain({
      name: "probe",
      schema: { type: "object", properties: {} },
      run: async () => {
        log.push("run")
        return "ok"
      },
    })
    await tool.invoke(call, configWith(rec))
    expect(log).toEqual(["issue:probe:call_1", "run", "settle:call_1"])
    expect(rec.has).not.toHaveBeenCalled()
    expect(rec.record).not.toHaveBeenCalled()
  })

  it("does not settle when the tool parks on a GraphInterrupt", async () => {
    const { log, recorder: rec } = recorder()
    const tool = convertToolToLangChain({
      name: "probe",
      schema: { type: "object", properties: {} },
      run: async () => {
        throw new GraphInterrupt([])
      },
    })
    await expect(tool.invoke(call, configWith(rec))).rejects.toThrow()
    expect(log).toEqual(["issue:probe:call_1"])
  })

  it("settles when the tool throws, and the error becomes the call's error result", async () => {
    const { log, recorder: rec } = recorder()
    const tool = convertToolToLangChain({
      name: "probe",
      schema: { type: "object", properties: {} },
      run: async () => {
        throw new Error("boom")
      },
    })
    const result = (await tool.invoke(call, configWith(rec))) as ToolMessage
    expect(result).toBeInstanceOf(ToolMessage)
    expect(result.status).toBe("error")
    expect(result.content).toBe("Error: boom\n Please fix your mistakes.")
    expect(result.additional_kwargs[B4_STEP_KEY]).toMatchObject({ status: "failed" })
    expect(log).toEqual(["issue:probe:call_1", "settle:call_1"])
  })

  it("settles when the call is aborted mid-run", async () => {
    const { log, recorder: rec } = recorder()
    const controller = new AbortController()
    const tool = convertToolToLangChain({
      name: "probe",
      schema: { type: "object", properties: {} },
      run: (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")))
          controller.abort()
        }),
    })
    await expect(
      tool.invoke(call, { ...configWith(rec), signal: controller.signal }),
    ).rejects.toThrow("aborted")
    expect(log).toEqual(["issue:probe:call_1", "settle:call_1"])
  })

  it("skips a tool carrying the clientTool marker", async () => {
    const { log, recorder: rec } = recorder()
    const tool = convertToolToLangChain({
      name: "client_openPanel",
      schema: { type: "object", properties: {} },
      clientTool: true,
      run: async () => "ok",
    })
    await tool.invoke({ ...call, name: "client_openPanel" }, configWith(rec))
    expect(log).toEqual([])
  })

  it("does nothing with no recorder, and nothing without a provider tool-call id", async () => {
    const { log, recorder: rec } = recorder()
    const tool = convertToolToLangChain({
      name: "probe",
      schema: { type: "object", properties: {} },
      run: async () => "ok",
    })
    await tool.invoke(call, { configurable: {} })
    await tool.invoke({}, configWith(rec))
    expect(log).toEqual([])
  })

  it("an issue failure fails the call before the tool body runs", async () => {
    const { log, recorder: rec } = recorder()
    rec.issue = async () => {
      throw new Error("store down")
    }
    const tool = convertToolToLangChain({
      name: "probe",
      schema: { type: "object", properties: {} },
      run: async () => {
        log.push("run")
        return "ok"
      },
    })
    await expect(tool.invoke(call, configWith(rec))).rejects.toThrow("store down")
    expect(log).toEqual([])
  })

  it("a settle failure is warned and swallowed; the result stands", async () => {
    const { recorder: rec } = recorder()
    rec.settle = async () => {
      throw new Error("store down")
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const tool = convertToolToLangChain({
        name: "probe",
        schema: { type: "object", properties: {} },
        run: async () => "ok",
      })
      const result = await tool.invoke(call, configWith(rec))
      expect(result).toBeDefined()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("could not settle tool call"),
        expect.any(Error),
      )
    } finally {
      warn.mockRestore()
    }
  })

  test("dispatches a running step before the body and a completed step after it, with labels", async () => {
    const order: string[] = []
    dispatchCustomEvent.mockImplementation(async (name: string, payload: unknown) => {
      order.push(
        `${name}:${(payload as { status?: string }).status ?? (payload as { event?: string }).event}`,
      )
    })
    const converted = convertToolToLangChain({
      name: "searchCorpus",
      display: {
        icon: "search",
        running: (input: { query: string }) => `Searching the corpus for “${input.query}”`,
        done: (input: { query: string }, output: { path: string }[]) =>
          `Searched the corpus for “${input.query}” (${output.length} hits)`,
        sources: (output: { path: string }[]) => output.map((hit) => ({ title: hit.path })),
      },
      run: async () => {
        order.push("run")
        return [{ path: "corpus/a.md" }]
      },
    })
    const config = { configurable: {}, toolCall: { id: "call_search_1" } }
    await converted.func({ query: "agents" }, undefined, config)
    expect(order).toEqual(["b4.step:running", "run", "b4.step:completed"])
    expect(dispatchCustomEvent).toHaveBeenNthCalledWith(
      1,
      "b4.step",
      {
        tool_call_id: "call_search_1",
        status: "running",
        icon: "search",
        label: "Searching the corpus for “agents”",
      },
      expect.anything(),
    )
    expect(dispatchCustomEvent).toHaveBeenNthCalledWith(
      2,
      "b4.step",
      {
        tool_call_id: "call_search_1",
        status: "completed",
        icon: "search",
        label: "Searched the corpus for “agents” (1 hits)",
        sources: [{ title: "corpus/a.md" }],
      },
      expect.anything(),
    )
  })

  test("a denied call settles as `denied` with the icon only — no done label or sources — on a success ToolMessage the model still reads", async () => {
    const reason = "[B4_E3001] Permission denied by user: tool searchCorpus"
    const converted = convertToolToLangChain({
      name: "searchCorpus",
      display: {
        icon: "search",
        running: (input: { query: string }) => `Searching the corpus for “${input.query}”`,
        done: (input: { query: string }, output: unknown) =>
          `Searched the corpus for “${input.query}” (${(output as string).length} hits)`,
        sources: (output: unknown) => [{ title: String(output) }],
      },
      // What wrapToolWithApproval / wrapToolWithConstraint return for a blocked call.
      run: async () => toolDenial(reason),
    })
    const config = { configurable: {}, toolCall: { id: "call_search_denied" } }
    const result = (await converted.func(
      { query: "agents" },
      undefined,
      config as never,
    )) as ToolMessage
    // `running` streams, then `denied` (never `completed`): a denial is not a
    // failure, so the ToolMessage keeps `success` and the step persists as denied.
    expect(dispatchCustomEvent).toHaveBeenCalledTimes(2)
    expect(dispatchCustomEvent).toHaveBeenNthCalledWith(
      1,
      "b4.step",
      {
        tool_call_id: "call_search_denied",
        status: "running",
        icon: "search",
        label: "Searching the corpus for “agents”",
      },
      expect.anything(),
    )
    expect(dispatchCustomEvent).toHaveBeenNthCalledWith(
      2,
      "b4.step",
      { tool_call_id: "call_search_denied", status: "denied", icon: "search" },
      expect.anything(),
    )
    expect(result).toBeInstanceOf(ToolMessage)
    expect(result.status).toBe("success")
    expect(result.content).toBe(reason)
    expect(result.additional_kwargs[B4_STEP_KEY]).toEqual({
      status: "denied",
      icon: "search",
      startedAt: expect.any(String),
      settledAt: expect.any(String),
    })
  })

  test("a denied call on a display without an icon still settles as denied and persists a bare denied step", async () => {
    const converted = convertToolToLangChain({
      name: "deployProd",
      display: { done: () => "Deployed to production" },
      run: async () => toolDenial("Permission denied by user: tool deployProd"),
    })
    const config = { configurable: {}, toolCall: { id: "call_deploy_denied" } }
    const result = (await converted.func({}, undefined, config as never)) as ToolMessage
    expect(dispatchCustomEvent).toHaveBeenCalledTimes(2)
    expect(dispatchCustomEvent).toHaveBeenNthCalledWith(
      1,
      "b4.step",
      { tool_call_id: "call_deploy_denied", status: "running" },
      expect.anything(),
    )
    expect(dispatchCustomEvent).toHaveBeenNthCalledWith(
      2,
      "b4.step",
      { tool_call_id: "call_deploy_denied", status: "denied" },
      expect.anything(),
    )
    expect(result.status).toBe("success")
    expect(result.content).toBe("Permission denied by user: tool deployProd")
    expect(result.additional_kwargs[B4_STEP_KEY]).toEqual({
      status: "denied",
      startedAt: expect.any(String),
      settledAt: expect.any(String),
    })
  })

  test("a denied call on a tool without display is a success ToolMessage whose content is the reason, persisting a bare denied step", async () => {
    const converted = convertToolToLangChain({
      name: "plain",
      run: async () => toolDenial("Blocked: nope"),
    })
    const result = (await converted.func({}, undefined, {
      configurable: {},
      toolCall: { id: "call_plain_denied" },
    } as never)) as ToolMessage
    expect(result).toBeInstanceOf(ToolMessage)
    expect(result.status).toBe("success")
    expect(result.content).toBe("Blocked: nope")
    expect(result.additional_kwargs[B4_STEP_KEY]).toMatchObject({ status: "denied" })
    expect(dispatchCustomEvent).not.toHaveBeenCalled()
  })

  test("a tool without display dispatches no step and still persists a bare completed one", async () => {
    const converted = convertToolToLangChain({ name: "plain", run: async () => "ok" })
    const result = (await converted.func({}, undefined, {
      configurable: {},
      toolCall: { id: "c1" },
    } as never)) as ToolMessage
    expect(result).toBeInstanceOf(ToolMessage)
    expect(result.status).toBe("success")
    expect(result.tool_call_id).toBe("c1")
    expect(result.content).toBe('"ok"')
    expect(result.additional_kwargs[B4_STEP_KEY]).toEqual({
      status: "completed",
      startedAt: expect.any(String),
      settledAt: expect.any(String),
    })
    expect(dispatchCustomEvent).not.toHaveBeenCalled()
  })

  test("a tool with display returns a ToolMessage carrying the step in additional_kwargs", async () => {
    const converted = convertToolToLangChain({
      name: "readDoc",
      display: { icon: "read", done: (input: { path: string }) => `Read ${input.path}` },
      run: async () => ({ content: "# Title" }),
    })
    const result = (await converted.func({ path: "corpus/a.md" }, undefined, {
      configurable: {},
      toolCall: { id: "call_read_1" },
    } as never)) as {
      content: unknown
      tool_call_id: string
      additional_kwargs: Record<string, unknown>
    }
    expect(result.content).toBe('{"content":"# Title"}')
    expect(result.tool_call_id).toBe("call_read_1")
    expect(result.additional_kwargs[B4_STEP_KEY]).toEqual({
      status: "completed",
      icon: "read",
      label: "Read corpus/a.md",
      startedAt: expect.any(String),
      settledAt: expect.any(String),
    })
  })

  test("a {result, state} tool with display keeps the Command and annotates its ToolMessage", async () => {
    const converted = convertToolToLangChain({
      name: "savePlan",
      display: { icon: "plan", done: () => "Updated the plan" },
      run: async () => ({ result: "saved", state: { todos: [] } }),
    })
    const result = await converted.func({}, undefined, {
      configurable: {},
      toolCall: { id: "call_plan_1" },
    } as never)
    expect(isCommand(result)).toBe(true)
    const update = (result as Command).update as {
      messages: { additional_kwargs: Record<string, unknown> }[]
    }
    expect(update.messages[0]?.additional_kwargs[B4_STEP_KEY]).toEqual({
      status: "completed",
      icon: "plan",
      label: "Updated the plan",
      startedAt: expect.any(String),
      settledAt: expect.any(String),
    })
  })

  test("without a provider tool-call id no step is dispatched (nothing to attach it to)", async () => {
    const converted = convertToolToLangChain({
      name: "searchCorpus",
      display: { running: () => "Searching" },
      run: async () => "ok",
    })
    await converted.func({}, undefined, { configurable: {} })
    expect(dispatchCustomEvent).not.toHaveBeenCalled()
  })
})
