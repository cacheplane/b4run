import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { StringOutputParser } from "@langchain/core/output_parsers"
import type { ChatResult } from "@langchain/core/outputs"
import { ChatPromptTemplate } from "@langchain/core/prompts"
import {
  RunnableEach,
  RunnableLambda,
  RunnableMap,
  RunnablePassthrough,
} from "@langchain/core/runnables"
import { tool } from "@langchain/core/tools"
import { expect, it } from "vitest"
import { chainAdapter } from "../src/chain-adapter.ts"

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

it("preserves a shared model, callbacks and ordinary invocation state without primitive hooks", async () => {
  class Model extends BaseChatModel {
    readonly calls: string[] = []
    _llmType() {
      return "shared-invocation"
    }
    async _generate(messages: BaseMessage[]): Promise<ChatResult> {
      const text = String(messages.at(-1)?.content)
      this.calls.push(text)
      return { generations: [{ text, message: new AIMessage(text) }] }
    }
  }
  const model = new Model({}),
    original = model._generate
  let callbacks = 0
  const chain = ChatPromptTemplate.fromMessages([["human", "{query}"]])
    .pipe(model)
    .pipe(new StringOutputParser())
    .withConfig({
      callbacks: [
        {
          name: "observer",
          handleLLMEnd() {
            callbacks++
          },
        },
      ],
    })
  expect(
    await Promise.all(
      ["a", "b"].map((query) =>
        chainAdapter.execute(
          chain,
          { query },
          {
            signal: new AbortController().signal,
          },
        ),
      ),
    ),
  ).toEqual(["a", "b"])
  expect(model.calls.sort()).toEqual(["a", "b"])
  expect(callbacks).toBe(2)
  expect(model._generate).toBe(original)
  expect(Object.hasOwn(model, "_generate")).toBe(false)
})

it("accepts opaque frozen runnable receivers without a completion-hook restriction", async () => {
  const entry = Object.freeze({
    prefix: "receiver",
    async invoke(input: unknown) {
      return `${this.prefix}:${input}`
    },
  })
  expect(await chainAdapter.execute(entry, "input", { signal: new AbortController().signal })).toBe(
    "receiver:input",
  )
})

it("preserves an actual StructuredTool error without changing its invocation method", async () => {
  const fault = new Error("authored tool failure")
  const actual = tool(
    async () => {
      throw fault
    },
    { name: "effect", description: "Effect.", schema: { type: "object", properties: {} } },
  )
  const original = actual.invoke
  await expect(
    chainAdapter.execute(actual, {}, { signal: new AbortController().signal }),
  ).rejects.toBe(fault)
  expect(actual.invoke).toBe(original)
})
