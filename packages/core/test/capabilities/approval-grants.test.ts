import { APPROVAL_GRANT_MINTER_KEY, type ApprovalGrantMinter } from "@b4run/sdk"
import {
  Annotation,
  Command,
  END,
  interrupt,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  __resetApprovalGrantsForTests,
  approvalGrantMode,
  configureApprovalGrants,
  MissingApprovalGrantMinterError,
  mintGrantForPark,
} from "../../src/capabilities/approval-grants.js"

const State = Annotation.Root({
  parked: Annotation<unknown>({ reducer: (_a, b) => b, default: () => undefined }),
})

/**
 * A graph whose single node does what `emitPermissionInterrupt` does: mint a
 * grant for the park, then `interrupt()` with it in the envelope. Exercised
 * through a real compiled graph rather than by faking `getConfig()`, because
 * the thing under test IS that the ambient run config reaches the park site.
 */
function parkingGraph(interruptId: string, onError?: (error: unknown) => void) {
  return new StateGraph(State)
    .addNode("park", async () => {
      let grant: string | undefined
      try {
        grant = await mintGrantForPark(interruptId)
      } catch (error) {
        onError?.(error)
        throw error
      }
      const payload = { interruptId, type: "permission-request" as const }
      const decision = interrupt(grant === undefined ? payload : { ...payload, grant })
      return { parked: decision }
    })
    .addEdge(START, "park")
    .addEdge("park", END)
    .compile({ checkpointer: new MemorySaver() })
}

function recordingMinter(): ApprovalGrantMinter & {
  readonly calls: { interruptId: string; checkpointNs: string }[]
} {
  const calls: { interruptId: string; checkpointNs: string }[] = []
  return {
    calls,
    async mint(args) {
      calls.push({ ...args })
      return `b4ag_grant-for-${args.interruptId}`
    },
  }
}

/** Pull the parked `__interrupt__` envelope back out of the checkpoint. */
function parkedEnvelope(result: unknown): Record<string, unknown> | undefined {
  const interrupts = (result as { __interrupt__?: { value?: unknown }[] }).__interrupt__
  const value = interrupts?.[0]?.value
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

describe("approval grants — park-site minting", () => {
  beforeEach(() => __resetApprovalGrantsForTests())
  afterEach(() => __resetApprovalGrantsForTests())

  it('defaults to "off" and mints nothing', async () => {
    expect(approvalGrantMode()).toBe("off")
    const minter = recordingMinter()
    const app = parkingGraph("perm-1")
    const result = await app.invoke(
      {},
      { configurable: { thread_id: "t", [APPROVAL_GRANT_MINTER_KEY]: minter } },
    )
    expect(minter.calls).toEqual([])
    expect(parkedEnvelope(result)).not.toHaveProperty("grant")
  })

  it("mints through config.configurable and puts the grant in the parked envelope", async () => {
    configureApprovalGrants("required")
    const minter = recordingMinter()
    const app = parkingGraph("perm-2")
    const result = await app.invoke(
      {},
      { configurable: { thread_id: "t", [APPROVAL_GRANT_MINTER_KEY]: minter } },
    )
    expect(minter.calls).toHaveLength(1)
    expect(minter.calls[0]?.interruptId).toBe("perm-2")
    // The preimage of the `resumeKey` the client sees — LangGraph namespaces a
    // parked task as `<node>:<task-uuid>`, so this is non-empty and positional.
    expect(minter.calls[0]?.checkpointNs).toMatch(/^park:/)
    expect(parkedEnvelope(result)).toMatchObject({
      interruptId: "perm-2",
      grant: "b4ag_grant-for-perm-2",
    })
  })

  it("resumes normally once a grant has been minted", async () => {
    configureApprovalGrants("required")
    const app = parkingGraph("perm-3")
    const config = {
      configurable: { thread_id: "t", [APPROVAL_GRANT_MINTER_KEY]: recordingMinter() },
    }
    await app.invoke({}, config)
    const resumed = await app.invoke(new Command({ resume: "once" }), config)
    expect((resumed as { parked?: unknown }).parked).toBe("once")
  })

  // ── The rule that makes core-minting safe ──────────────────────────────────
  //
  // Injection through `config.configurable` is OPTIONAL BY CONSTRUCTION:
  // pre-wrap and legacy invokers omit it, exactly as they omit `threadId`.
  // Under "required" that absence must abort the turn, not produce a park with
  // no grant — because under "optional" such a park is a bypass, and the park
  // site is the only place that knows a grant is about to be needed.
  //
  // If you are here because this test failed: do not relax it. A park without
  // a grant under "required" is the exact hole this feature exists to close.
  it("REFUSES TO PARK when grants are required and no minter is in the run config", async () => {
    configureApprovalGrants("required")
    let captured: unknown
    const app = parkingGraph("perm-4", (error) => {
      captured = error
    })

    // No APPROVAL_GRANT_MINTER_KEY — a legacy invoker.
    await expect(app.invoke({}, { configurable: { thread_id: "t" } })).rejects.toThrow(
      MissingApprovalGrantMinterError,
    )
    expect(captured).toBeInstanceOf(MissingApprovalGrantMinterError)
    expect((captured as MissingApprovalGrantMinterError).code).toBe("approval_grant_minter_missing")
    expect((captured as Error).message).toContain("perm-4")

    // And nothing was parked: the checkpoint must not hold an answerable
    // prompt. A refusal that still parked would be the bypass wearing a
    // stack trace.
    const state = await app.getState({ configurable: { thread_id: "t" } })
    expect(state.tasks.flatMap((task) => task.interrupts ?? [])).toEqual([])
  })

  it('refuses when the configurable key holds a non-minter under "required"', async () => {
    configureApprovalGrants("required")
    const app = parkingGraph("perm-5")
    // `configurable` also carries route params, which come from the URL. A
    // value that merely occupies the key must not be treated as a minter.
    await expect(
      app.invoke({}, { configurable: { thread_id: "t", [APPROVAL_GRANT_MINTER_KEY]: "nope" } }),
    ).rejects.toThrow(MissingApprovalGrantMinterError)
  })

  it('parks without a grant under "optional" when no minter reached the run', async () => {
    configureApprovalGrants("optional")
    const app = parkingGraph("perm-6")
    const result = await app.invoke({}, { configurable: { thread_id: "t" } })
    const envelope = parkedEnvelope(result)
    expect(envelope).toMatchObject({ interruptId: "perm-6" })
    expect(envelope).not.toHaveProperty("grant")
  })

  it("ratchets the mode up and never down", () => {
    configureApprovalGrants("optional")
    expect(approvalGrantMode()).toBe("optional")
    configureApprovalGrants("required")
    expect(approvalGrantMode()).toBe("required")
    // A second app root in one process must not be able to weaken a stricter
    // mode already in force.
    configureApprovalGrants("off")
    expect(approvalGrantMode()).toBe("required")
    configureApprovalGrants("optional")
    expect(approvalGrantMode()).toBe("required")
  })

  it("returns undefined outside a running graph rather than throwing LangGraph internals", async () => {
    expect(await mintGrantForPark("perm-7")).toBeUndefined()
    configureApprovalGrants("optional")
    expect(await mintGrantForPark("perm-7")).toBeUndefined()
  })

  it("still fails closed outside a running graph under required", async () => {
    configureApprovalGrants("required")
    await expect(mintGrantForPark("perm-8")).rejects.toThrow(MissingApprovalGrantMinterError)
  })
})
