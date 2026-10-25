import { B4_TOOL_STEP_JSON_SCHEMA, type B4ToolStep } from "@b4run/sdk"
import { foldToolStepEvents, TOOL_STEP_FIXTURES } from "@b4run/sdk/testing"
import { RunnableLambda } from "@langchain/core/runnables"
import { Validator } from "@langchain/core/utils/json_schema"
import { expect, test } from "vitest"
import { emitToolStep } from "../src/ui.ts"

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const value of values) result.push(value)
  return result
}

const step = { v: 1, toolCallId: "call-1", kind: "server", status: "running" } as const

test("emits a normalized b4.step through real streamEvents v2", async () => {
  const input = {
    ...step,
    label: "😀".repeat(121),
    queries: ["query"],
    sources: [{ id: "source", kind: "url" as const, title: "Title", href: "https://example.com" }],
  }
  const runnable = RunnableLambda.from(async (_: string, config) => {
    await emitToolStep(config, input)
    input.queries.push("later")
    const source = input.sources[0]
    if (source !== undefined) source.title = "Changed"
    return "result"
  })

  const events = await collect(runnable.streamEvents("input", { version: "v2" }))
  const custom = events.filter((event) => event.event === "on_custom_event")

  expect(custom).toHaveLength(1)
  expect(custom[0]?.name).toBe("b4.step")
  expect(custom[0]?.data).toEqual({
    ...step,
    label: "😀".repeat(120),
    queries: ["query"],
    sources: [{ id: "source", kind: "url", title: "Title", href: "https://example.com" }],
  })
  expect(events.at(-1)?.data.output).toBe("result")
  expect(events.some((event) => event.event.startsWith("on_tool_"))).toBe(false)
})

test("normalizes failed errors and strips errors from other statuses", async () => {
  const runnable = RunnableLambda.from(async (_: string, config) => {
    await emitToolStep(config, { ...step, status: "failed", error: { message: "" } })
    await emitToolStep(config, { ...step, status: "completed", error: { message: "ignored" } })
  })

  const events = await collect(runnable.streamEvents("input", { version: "v2" }))
  const values = events
    .filter((event) => event.event === "on_custom_event")
    .map((event) => event.data)

  expect(values).toEqual([
    { ...step, status: "failed", error: { message: "Tool call did not finish" } },
    { ...step, status: "completed" },
  ])
})

test.each([
  null,
  {},
  { ...step, v: 2 },
  { ...step, v: undefined },
  { ...step, toolCallId: "" },
  { ...step, toolCallId: "   " },
  { ...step, toolCallId: 1 },
  { ...step, kind: "other" },
  { ...step, status: "other" },
])("rejects invalid direct producer input %j", async (input) => {
  await expect(emitToolStep(undefined, input as never)).rejects.toThrow(TypeError)
})

test("uses the active Node runnable config when config is omitted", async () => {
  const runnable = RunnableLambda.from(async () => {
    await emitToolStep(undefined, step)
    return "ok"
  })

  const events = await collect(runnable.streamEvents("input", { version: "v2" }))

  expect(events.find((event) => event.event === "on_custom_event")?.data).toEqual(step)
})

test("absent listeners and outside-runnable dispatch do not fail a tool", async () => {
  const runnable = RunnableLambda.from(async () => {
    await emitToolStep(undefined, step)
    return "ok"
  })

  await expect(emitToolStep(undefined, step)).resolves.toBeUndefined()
  await expect(runnable.invoke("input")).resolves.toBe("ok")
})

test("a throwing callback is secondary to the tool result", async () => {
  const runnable = RunnableLambda.from(async (_: string, config) => {
    await emitToolStep(config, step)
    return "ok"
  })
  const callback = {
    name: "broken",
    awaitHandlers: true,
    raiseError: true,
    handleCustomEvent() {
      throw new Error("transport failed")
    },
  }

  const result = await runnable.invoke("input", { callbacks: [callback] })

  expect(result).toBe("ok")
})

test("owns nested errors before callbacks can mutate them", async () => {
  const input: B4ToolStep & { toolCallId: string } = {
    ...step,
    status: "failed",
    error: { message: "original", code: "code" },
  }
  const callback = {
    name: "mutator",
    handleCustomEvent(_name: string, value: { error: { message: string } }) {
      value.error.message = "changed"
    },
  }
  const runnable = RunnableLambda.from(async (_: string, config) => {
    await emitToolStep(config, input)
  })

  await runnable.invoke("input", { callbacks: [callback] })

  expect(input.error).toEqual({ message: "original", code: "code" })
})

test("an awaited blocked listener completes before emission resolves", async () => {
  let release: () => void = () => {}
  let entered: () => void = () => {}
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let completed = false
  const callback = {
    name: "blocked",
    awaitHandlers: true,
    async handleCustomEvent() {
      entered()
      await blocked
    },
  }
  const runnable = RunnableLambda.from(async (_: string, config) => {
    await emitToolStep(config, step)
    completed = true
    return "ok"
  })

  const result = runnable.invoke("input", { callbacks: [callback] })
  await started
  expect(completed).toBe(false)
  release()

  expect(await result).toBe("ok")
  expect(completed).toBe(true)
})

test("emission preserves caller config and callbacks", async () => {
  const tags = ["caller"]
  const metadata = { caller: "value" }
  const callback = { name: "owned", awaitHandlers: true, handleCustomEvent() {} }
  const callbacks = [callback]
  const runnable = RunnableLambda.from(async () => {
    const config = Object.freeze({ callbacks, tags, metadata })
    await emitToolStep(config, step)
    return config
  })

  const result = await runnable.invoke("input")

  expect(result.callbacks).toBe(callbacks)
  expect(result.callbacks).toEqual([callback])
  expect(result.tags).toBe(tags)
  expect(tags).toEqual(["caller"])
  expect(result.metadata).toBe(metadata)
  expect(metadata).toEqual({ caller: "value" })
  expect(Object.keys(callback)).toEqual(["name", "awaitHandlers", "handleCustomEvent"])
})

test("actual custom events reproduce the SDK lifecycle fixture", async () => {
  const fixture = TOOL_STEP_FIXTURES.find((value) => value.name === "custom-only-lifecycle")
  if (fixture === undefined) throw Error("Missing SDK lifecycle fixture")
  const runnable = RunnableLambda.from(async (_: string, config) => {
    for (const event of fixture.events) {
      if (event.type === "CUSTOM")
        await emitToolStep(config, event.value as B4ToolStep & { toolCallId: string })
    }
  })

  const events = await collect(runnable.streamEvents("input", { version: "v2" }))
  const actual = events.filter((event) => event.event === "on_custom_event")
  let customIndex = 0
  const replay = fixture.events.map((event) => {
    if (event.type !== "CUSTOM") return event
    const emitted = actual[customIndex++]
    if (emitted === undefined) throw Error("Missing emitted SDK fixture event")
    return { type: "CUSTOM", name: emitted.name, value: emitted.data }
  })

  expect(actual).toHaveLength(2)
  expect(foldToolStepEvents(replay)).toEqual(fixture.expected)
})

test("emitted SDK fixture values and JSON round trips satisfy the published producer schema", async () => {
  const validator = new Validator(JSON.parse(JSON.stringify(B4_TOOL_STEP_JSON_SCHEMA)))
  const producers = TOOL_STEP_FIXTURES.flatMap((fixture) =>
    Object.entries(fixture.expected.steps).map(([toolCallId, value]) => ({ ...value, toolCallId })),
  )
  const runnable = RunnableLambda.from(async (_: string, config) => {
    for (const value of producers) await emitToolStep(config, value)
  })

  const events = await collect(runnable.streamEvents("input", { version: "v2" }))
  const values = events
    .filter((event) => event.event === "on_custom_event")
    .map((event) => event.data)

  expect(values).toHaveLength(producers.length)
  expect(values.length).toBeGreaterThan(20)
  for (const value of values) {
    expect(validator.validate(value)).toMatchObject({ valid: true })
    expect(validator.validate(JSON.parse(JSON.stringify(value)))).toMatchObject({ valid: true })
  }
})
