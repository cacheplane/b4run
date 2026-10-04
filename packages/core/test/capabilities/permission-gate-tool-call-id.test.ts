import type { PermissionsStore } from "@b4run/permissions"
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph"
import { describe, expect, it } from "vitest"
import {
  gateBashOp,
  gateMemorySupersede,
  gateToolOp,
  wrapToolWithApproval,
  wrapToolWithConstraint,
} from "../../src/capabilities/permission-gate.js"

const State = Annotation.Root({
  parked: Annotation<unknown>({ reducer: (_a, b) => b, default: () => undefined }),
})

/** An interactive store that knows nothing, so every gate parks. */
function askingStore(): PermissionsStore {
  return {
    mode: "interactive",
    match: () => "unknown",
    addAllow: async () => {},
  } as unknown as PermissionsStore
}

function parkingGraph(body: () => Promise<unknown>) {
  return new StateGraph(State)
    .addNode("park", async () => ({ parked: await body() }))
    .addEdge(START, "park")
    .addEdge("park", END)
    .compile({ checkpointer: new MemorySaver() })
}

/** Pull the parked `__interrupt__` envelope back out of the checkpoint. */
function parkedEnvelope(result: unknown): Record<string, unknown> | undefined {
  const interrupts = (result as { __interrupt__?: { value?: unknown }[] }).__interrupt__
  const value = interrupts?.[0]?.value
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

interface RunTool {
  readonly name: string
  readonly run: (input: unknown, ctx: { signal: AbortSignal; toolCallId?: string }) => unknown
}

const config = { configurable: { thread_id: "t" } }

describe("permission envelopes name the tool call they gate", () => {
  it("gateToolOp puts toolCallId on a kind:tool envelope", async () => {
    const app = parkingGraph(() =>
      gateToolOp(askingStore(), "deployProd", "{}", { toolCallId: "call_deploy_1" }),
    )
    const envelope = parkedEnvelope(await app.invoke({}, config))
    expect(envelope).toMatchObject({ kind: "tool", toolCallId: "call_deploy_1" })
  })

  it("gateBashOp puts toolCallId on a kind:command envelope", async () => {
    const app = parkingGraph(() =>
      gateBashOp(askingStore(), "node scripts/fetch.mjs", { toolCallId: "call_bash_1" }),
    )
    const envelope = parkedEnvelope(await app.invoke({}, config))
    expect(envelope).toMatchObject({ kind: "command", toolCallId: "call_bash_1" })
  })

  it("gateMemorySupersede puts toolCallId on a kind:memory envelope", async () => {
    const app = parkingGraph(() =>
      gateMemorySupersede(
        askingStore(),
        { namespace: "ns", identity: "id", oldId: "m1", oldContent: "a", newContent: "b" },
        { toolCallId: "call_mem_1" },
      ),
    )
    const envelope = parkedEnvelope(await app.invoke({}, config))
    expect(envelope).toMatchObject({ kind: "memory", toolCallId: "call_mem_1" })
  })

  it("omits toolCallId when the gate has none", async () => {
    const app = parkingGraph(() => gateBashOp(askingStore(), "ls"))
    const envelope = parkedEnvelope(await app.invoke({}, config))
    expect(envelope).not.toHaveProperty("toolCallId")
  })

  it("wrapToolWithApproval forwards the run context's toolCallId", async () => {
    const wrapped = wrapToolWithApproval<{ signal: AbortSignal; toolCallId?: string }, RunTool>(
      { name: "deployProd", run: async () => "deployed" },
      askingStore(),
    )
    const app = parkingGraph(() =>
      Promise.resolve(
        wrapped.run({}, { signal: new AbortController().signal, toolCallId: "call_deploy_2" }),
      ),
    )
    const envelope = parkedEnvelope(await app.invoke({}, config))
    expect(envelope).toMatchObject({ kind: "tool", toolCallId: "call_deploy_2" })
  })

  it("wrapToolWithConstraint forwards the run context's toolCallId when the predicate escalates", async () => {
    const wrapped = wrapToolWithConstraint<{ signal: AbortSignal; toolCallId?: string }, RunTool>(
      { name: "deployProd", run: async () => "deployed" },
      async () => ({ approve: true }),
      askingStore(),
      "/route",
    )
    const app = parkingGraph(() =>
      Promise.resolve(
        wrapped.run({}, { signal: new AbortController().signal, toolCallId: "call_deploy_3" }),
      ),
    )
    const envelope = parkedEnvelope(await app.invoke({}, config))
    expect(envelope).toMatchObject({ kind: "tool", toolCallId: "call_deploy_3" })
  })
})
