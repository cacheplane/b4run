import { describe, expect, test } from "vitest"
import { convertToolToLangChain } from "../src/tool-converter.js"

type Tool = Parameters<typeof convertToolToLangChain>[0]

/** A tool that reports the principal it was handed. */
const whoAmI = (seen: unknown[]): Tool => ({
  name: "whoAmI",
  run: async (_input, ctx) => {
    seen.push(ctx.principal)
    return "ok"
  },
})

const call = (tool: Tool, configurable: Record<string, unknown>, principal?: { id: string }) =>
  convertToolToLangChain(tool, undefined, undefined, ["tenant"], [], undefined, principal).func(
    {},
    undefined,
    { configurable, toolCall: { id: "call_1", name: "whoAmI", args: {} } } as never,
  )

describe("the tool context's principal", () => {
  test("is the one the runtime handed in", async () => {
    const seen: unknown[] = []
    await call(whoAmI(seen), { thread_id: "t" }, { id: "alice" })
    expect(seen).toEqual([{ id: "alice" }])
  })

  test("comes from LangGraph's auth user on LangSmith, where no runtime hands one in", async () => {
    const seen: unknown[] = []
    await call(whoAmI(seen), {
      thread_id: "t",
      langgraph_auth_user: { identity: "bob", b4_principal: { id: "bob", org: "acme" } },
    })
    expect(seen).toEqual([{ id: "bob", org: "acme" }])
  })

  test("prefers the runtime's principal over anything in configurable", async () => {
    const seen: unknown[] = []
    await call(
      whoAmI(seen),
      { langgraph_auth_user: { b4_principal: { id: "mallory" } } },
      { id: "alice" },
    )
    expect(seen).toEqual([{ id: "alice" }])
  })

  test("cannot be forged by a string route param, the only thing a request puts in configurable", async () => {
    const seen: unknown[] = []
    await call(whoAmI(seen), { tenant: "acme", langgraph_auth_user: '{"b4_principal":{"id":"x"}}' })
    await call(whoAmI(seen), { langgraph_auth_user: { b4_principal: { id: 7 } } })
    expect(seen).toEqual([undefined, undefined])
  })
})
