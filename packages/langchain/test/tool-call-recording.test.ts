import { CLIENT_TOOL_RECORDER_KEY } from "@b4run/sdk"
import { GraphInterrupt } from "@langchain/langgraph"
import { describe, expect, it, vi } from "vitest"
import { readCallOrigin, recordToolCall } from "../src/tool-call-recording.ts"

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
const CALL = { toolCallId: "call_1", toolName: "probe" }
const configWith = (rec: unknown) => ({ configurable: { [CLIENT_TOOL_RECORDER_KEY]: rec } })

describe("recordToolCall", () => {
  it("issues before the body and settles after it returns; has/record untouched", async () => {
    const { log, recorder: rec } = recorder()
    const result = await recordToolCall(configWith(rec), CALL, async () => {
      log.push("body")
      return "ok"
    })
    expect(result).toBe("ok")
    expect(log).toEqual(["issue:probe:call_1", "body", "settle:call_1"])
    expect(rec.has).not.toHaveBeenCalled()
    expect(rec.record).not.toHaveBeenCalled()
  })

  it("does not settle when the body parks on a GraphInterrupt, and rethrows it", async () => {
    const { log, recorder: rec } = recorder()
    const park = new GraphInterrupt([])
    await expect(
      recordToolCall(configWith(rec), CALL, async () => {
        throw park
      }),
    ).rejects.toBe(park)
    expect(log).toEqual(["issue:probe:call_1"])
  })

  it("settles when the body throws an ordinary error, and rethrows it", async () => {
    const { log, recorder: rec } = recorder()
    await expect(
      recordToolCall(configWith(rec), CALL, async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(log).toEqual(["issue:probe:call_1", "settle:call_1"])
  })

  it("runs the body untouched with no recorder, a recorder without issue/settle, or an empty id", async () => {
    const { log, recorder: rec } = recorder()
    const { issue: _i, settle: _s, ...clientOnly } = rec
    const body = vi.fn(async () => "ok")
    expect(await recordToolCall({ configurable: {} }, CALL, body)).toBe("ok")
    expect(await recordToolCall(undefined, CALL, body)).toBe("ok")
    expect(await recordToolCall(configWith(clientOnly), CALL, body)).toBe("ok")
    expect(await recordToolCall(configWith(rec), { ...CALL, toolCallId: "" }, body)).toBe("ok")
    expect(body).toHaveBeenCalledTimes(4)
    expect(log).toEqual([])
  })

  it("an issue failure propagates before the body runs", async () => {
    const { log, recorder: rec } = recorder()
    rec.issue = async () => {
      throw new Error("store down")
    }
    const body = vi.fn(async () => "ok")
    await expect(recordToolCall(configWith(rec), CALL, body)).rejects.toThrow("store down")
    expect(body).not.toHaveBeenCalled()
    expect(log).toEqual([])
  })

  it("a settle failure is warned and swallowed; the result stands", async () => {
    const { recorder: rec } = recorder()
    rec.settle = async () => {
      throw new Error("store down")
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(await recordToolCall(configWith(rec), CALL, async () => "ok")).toBe("ok")
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("could not settle tool call call_1 for probe"),
        expect.any(Error),
      )
    } finally {
      warn.mockRestore()
    }
  })
})

describe("readCallOrigin", () => {
  const entry = (callId: string, routeKey: string) => ({
    callId,
    name: "researcher",
    routeId: routeKey.replace(/#.*$/, ""),
    routeKey,
  })

  it("is undefined at the root (no config, no metadata, empty stack)", () => {
    expect(readCallOrigin(undefined)).toBeUndefined()
    expect(readCallOrigin({ metadata: {} })).toBeUndefined()
    expect(readCallOrigin({ metadata: { b4: { subagent_stack: [] } } })).toBeUndefined()
  })

  it("names the top stack entry's route key and task call id", () => {
    const config = {
      metadata: {
        b4: {
          subagent_stack: [
            entry("call_task_outer", "/chat/subagents/planner#agent"),
            entry("call_task_inner", "/chat/subagents/planner/subagents/researcher#agent"),
          ],
        },
      },
    }
    expect(readCallOrigin(config)).toEqual({
      routeId: "/chat/subagents/planner/subagents/researcher#agent",
      parentToolCallId: "call_task_inner",
    })
  })

  it("ignores a top entry without a route key", () => {
    const config = {
      metadata: { b4: { subagent_stack: [{ callId: "x", name: "n", routeId: "/r" }] } },
    }
    expect(readCallOrigin(config)).toBeUndefined()
  })
})

describe("recordToolCall — origin", () => {
  it("passes the origin through to issue untouched, and omits it when absent", async () => {
    const issued: unknown[] = []
    const rec = {
      has: async () => false,
      record: async () => {},
      issue: async (call: unknown) => {
        issued.push(call)
      },
      settle: async () => {},
    }
    const config = { configurable: { [CLIENT_TOOL_RECORDER_KEY]: rec } }
    const origin = { routeId: "/chat/subagents/researcher#agent", parentToolCallId: "call_task_1" }
    await recordToolCall(
      config,
      { toolCallId: "c1", toolName: "readFile", origin },
      async () => "ok",
    )
    await recordToolCall(config, { toolCallId: "c2", toolName: "readFile" }, async () => "ok")
    expect(issued).toEqual([
      { toolCallId: "c1", toolName: "readFile", origin },
      { toolCallId: "c2", toolName: "readFile" },
    ])
  })
})
