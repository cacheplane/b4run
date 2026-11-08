import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages"
import { StringOutputParser } from "@langchain/core/output_parsers"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
import { ChatPromptTemplate } from "@langchain/core/prompts"
import {
  RunnableEach,
  RunnableLambda,
  RunnableMap,
  RunnablePassthrough,
} from "@langchain/core/runnables"
import { tool } from "@langchain/core/tools"
import { Annotation, END, getConfig, START, StateGraph } from "@langchain/langgraph"
import { expect, it } from "vitest"
import { graphAdapter } from "../../langgraph/dist/langgraph-adapter.js"
import { chainAdapter } from "../src/chain-adapter.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

it("preserves prompt/model/parser callbacks and a shared stateful model across isolated concurrent Runs", async () => {
  const gates = {
    a: { entered: deferred(), release: deferred() },
    b: { entered: deferred(), release: deferred() },
  }
  const events: string[] = []
  let constructions = 0
  class Controlled extends BaseChatModel {
    readonly calls: string[] = []
    constructor() {
      super({})
      constructions++
    }
    _llmType() {
      return "shared-controlled"
    }
    async _generate(messages: BaseMessage[]): Promise<ChatResult> {
      const name = String(messages.at(-1)!.content) as "a" | "b"
      this.calls.push(name)
      gates[name].entered.resolve()
      await gates[name].release.promise
      return { generations: [{ text: name, message: new AIMessage(name) }] }
    }
  }
  const model = new Controlled()
  const chain = ChatPromptTemplate.fromMessages([["human", "{query}"]])
    .pipe(model.withConfig({ tags: ["existing-model"] }))
    .pipe(new StringOutputParser())
    .withConfig({
      callbacks: [
        {
          name: "existing-observer",
          handleLLMEnd() {
            events.push("model-end")
          },
          handleChainEnd() {
            events.push("chain-end")
          },
        },
      ],
    })
  const a = new AbortController(),
    b = new AbortController()
  const first = chainAdapter.execute(chain, { query: "a" }, { signal: a.signal })
  const second = chainAdapter.execute(chain, { query: "b" }, { signal: b.signal })
  const results = [first, second].map((work) =>
    work.then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, error }),
    ),
  )
  try {
    await Promise.race([
      Promise.all([gates.a.entered.promise, gates.b.entered.promise]),
      Promise.race(results).then((result) => {
        throw "error" in result ? result.error : new Error("Finished before raw model barrier")
      }),
    ])
    a.abort(new Error("stop a"))
    expect(
      await Promise.race([
        results[0]!.then(() => "settled"),
        new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 30)),
      ]),
    ).toBe("held")
    gates.a.release.resolve()
    expect((await results[0])?.ok).toBe(false)
    expect(
      await Promise.race([
        results[1]!.then(() => "settled"),
        new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 30)),
      ]),
    ).toBe("held")
    gates.b.release.resolve()
    expect(await results[1]).toEqual({ ok: true, value: "b" })
    expect(model.calls.sort()).toEqual(["a", "b"])
    expect(constructions).toBe(1)
    expect(events.filter((event) => event === "model-end")).toHaveLength(2)
    expect(events).toContain("chain-end")
  } finally {
    gates.a.release.resolve()
    gates.b.release.resolve()
    await Promise.all(results)
  }
}, 30_000)

it("preserves Map, Assign, Each and Passthrough outputs with actual Lambda work", async () => {
  const upper = RunnableLambda.from((value: string) => value.toUpperCase())
  const mapped = RunnableMap.from({ original: new RunnablePassthrough(), upper })
  expect(
    await chainAdapter.execute(mapped, "hi", { signal: new AbortController().signal }),
  ).toEqual({ original: "hi", upper: "HI" })
  const assigned = RunnablePassthrough.assign({
    computed: RunnableLambda.from((value: { value: string }) => value.value.toUpperCase()),
  })
  expect(
    await chainAdapter.execute(assigned, { value: "hi" }, { signal: new AbortController().signal }),
  ).toEqual({ value: "hi", computed: "HI" })
  expect(
    await chainAdapter.execute(new RunnableEach({ bound: upper }), ["a", "b"], {
      signal: new AbortController().signal,
    }),
  ).toEqual(["A", "B"])
}, 30_000)

it("awaits a real model stream generator finalizer when a consumer closes", async () => {
  const entered = deferred(),
    release = deferred()
  let finalized = false
  class Streaming extends BaseChatModel {
    _llmType() {
      return "controlled-lcel-stream"
    }
    async _generate(): Promise<ChatResult> {
      throw new Error("Nonstreaming path executed")
    }
    async *_streamResponseChunks(): AsyncGenerator<ChatGenerationChunk> {
      try {
        yield new ChatGenerationChunk({ text: "first", message: new AIMessageChunk("first") })
        entered.resolve()
        await release.promise
        yield new ChatGenerationChunk({ text: "last", message: new AIMessageChunk("last") })
      } finally {
        finalized = true
      }
    }
  }
  const chain = ChatPromptTemplate.fromMessages([["human", "{query}"]])
    .pipe(new Streaming({}))
    .pipe(new StringOutputParser())
  const stream = chainAdapter
    .stream(chain, { query: "stream" }, { signal: new AbortController().signal })
    [Symbol.asyncIterator]()
  let closing: Promise<unknown> | undefined
  try {
    expect((await stream.next()).value).toBe("first")
    await entered.promise
    closing = stream.return!()
    expect(
      await Promise.race([
        closing.then(() => "settled"),
        new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 30)),
      ]),
    ).toBe("held")
    expect(finalized).toBe(false)
    release.resolve()
    await closing
    expect(finalized).toBe(true)
  } finally {
    release.resolve()
    await closing
    await stream.return?.()
  }
}, 30_000)

it("preserves direct shared-model execution methods and state across successive Runs", async () => {
  class Direct extends BaseChatModel {
    calls = 0
    _llmType() {
      return "direct-shared-model"
    }
    async _generate(): Promise<ChatResult> {
      const text = String(++this.calls)
      return { generations: [{ text, message: new AIMessage(text) }] }
    }
  }
  const model = new Direct({}),
    invoke = model.invoke,
    stream = model.stream,
    events = model.streamEvents
  expect(
    (
      (await chainAdapter.execute(model, "first", {
        signal: new AbortController().signal,
      })) as AIMessage
    ).content,
  ).toBe("1")
  expect(model.invoke).toBe(invoke)
  expect(model.stream).toBe(stream)
  expect(model.streamEvents).toBe(events)
  expect(
    (
      (await chainAdapter.execute(model, "second", {
        signal: new AbortController().signal,
      })) as AIMessage
    ).content,
  ).toBe("2")
  expect(model.calls).toBe(2)
}, 30_000)

it("drains the correct nested invocation when callback markers are inherited", async () => {
  const entered = deferred(),
    release = deferred()
  let raw: Promise<unknown> | undefined,
    child: Promise<unknown> | undefined,
    childDone = false,
    effects = 0
  class Nested extends BaseChatModel {
    _llmType() {
      return "nested-owned-model"
    }
    async _generate(): Promise<ChatResult> {
      entered.resolve()
      await release.promise
      effects++
      return { generations: [{ text: "done", message: new AIMessage("done") }] }
    }
  }
  const model = new Nested({})
  const graph = new StateGraph(Annotation.Root({ value: Annotation<string> }))
    .addNode("launch", async () => {
      // The child adapter owns this declared model primitive. Arbitrary hidden
      // fire-and-forget promises in authored closures have no completion proof.
      raw = chainAdapter.execute(model, "nested", {
        signal: getConfig()?.signal ?? new AbortController().signal,
      })
      await raw
      return { value: "launched" }
    })
    .addEdge(START, "launch")
    .addEdge("launch", END)
    .compile()
  const parent = RunnableLambda.from(async (_input, config) => {
    child = graphAdapter.execute(
      graph,
      { value: "start" },
      { signal: config?.signal ?? new AbortController().signal },
    )
    void child.then(
      () => {
        childDone = true
      },
      () => {
        childDone = true
      },
    )
    return await child
  })
  const controller = new AbortController()
  const result = chainAdapter.execute(parent, "start", { signal: controller.signal }).then(
    () => "done",
    () => "aborted",
  )
  try {
    await entered.promise
    controller.abort(new Error("stop nested"))
    expect(
      await Promise.race([
        result,
        new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 30)),
      ]),
    ).toBe("held")
    expect(childDone).toBe(false)
    expect(effects).toBe(0)
    release.resolve()
    expect(await result).toBe("aborted")
    expect(childDone).toBe(true)
    expect(effects).toBe(1)
  } finally {
    release.resolve()
    await result
    await Promise.allSettled([raw, child])
  }
}, 30_000)

it("preflights a frozen model before installing any hook on another model", async () => {
  class Model extends BaseChatModel {
    _llmType() {
      return "preflight-model"
    }
    async _generate(): Promise<ChatResult> {
      throw new Error("Provider should not start")
    }
  }
  const first = new Model({}),
    frozen = Object.freeze(new Model({}))
  const generate = first._generate,
    invoke = first.invoke
  const prompt = ChatPromptTemplate.fromMessages([["human", "{query}"]])
  await expect(
    chainAdapter.execute(
      RunnableMap.from({ first: prompt.pipe(first), second: prompt.pipe(frozen) }),
      { query: "never" },
      { signal: new AbortController().signal },
    ),
  ).rejects.toMatchObject({ code: "not_supported" })
  expect(first._generate).toBe(generate)
  expect(first.invoke).toBe(invoke)
  expect(Object.hasOwn(first, "_generate")).toBe(false)
}, 30_000)

it("awaits an actual StructuredTool primitive and preserves its error and receiver", async () => {
  const entered = deferred(),
    release = deferred(),
    rawFinished = deferred(),
    fault = new Error("raw-tool-failure")
  let effects = 0
  const actual = tool(
    async () => {
      try {
        entered.resolve()
        await release.promise
        effects++
        throw fault
      } finally {
        rawFinished.resolve()
      }
    },
    {
      name: "ownedTool",
      description: "Controlled primitive.",
      schema: { type: "object", properties: {} },
    },
  )
  const invoke = actual.invoke,
    controller = new AbortController()
  const result = chainAdapter.execute(actual, {}, { signal: controller.signal }).then(
    () => undefined,
    (error: unknown) => error,
  )
  try {
    await entered.promise
    controller.abort(new Error("stop tool"))
    expect(
      await Promise.race([
        result.then(() => "settled"),
        new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 30)),
      ]),
    ).toBe("held")
    expect(effects).toBe(0)
    expect(actual.invoke).toBe(invoke)
    release.resolve()
    expect(await result).toBe(fault)
    expect(effects).toBe(1)
  } finally {
    release.resolve()
    await result
    await rawFinished.promise
  }
}, 30_000)
