import { describe, expect, it } from "vitest"
import { createCommandLog } from "../src/lib/registry/commands.ts"
import { openRegistry } from "../src/lib/registry/db.ts"

const at = "2026-09-16T00:00:00.000Z"
const intent = { command: "dispatch" as const, args: {} }

describe("command log", () => {
  it("is new the first time, in flight until completed, then done with the recorded outcome", () => {
    const log = createCommandLog(openRegistry(":memory:").db)
    expect(log.begin("k1", "wo-1", intent, at)).toEqual({ status: "new" })
    expect(log.begin("k1", "wo-1", intent, at)).toEqual({ status: "in_flight", intent })
    log.complete("k1", { ok: true, state: "dispatched", message: "dispatched" })
    expect(log.begin("k1", "wo-1", intent, at)).toEqual({
      status: "done",
      outcome: { ok: true, state: "dispatched", message: "dispatched" },
    })
  })

  it("refuses a key reused for another work order or another command, on begin and on outcome", () => {
    const log = createCommandLog(openRegistry(":memory:").db)
    log.begin("k1", "wo-1", intent, at)
    // In flight: no outcome to replay, but the key is still wo-1's dispatch.
    expect(log.outcome("k1", "wo-1", intent)).toBeNull()
    log.complete("k1", { ok: true, state: "dispatched", message: "Dispatched" })
    expect(log.outcome("k1", "wo-1", intent)).toEqual({
      ok: true,
      state: "dispatched",
      message: "Dispatched",
    })
    expect(log.outcome("unused", "wo-1", intent)).toBeNull()
    const retry = { command: "retry" as const, args: {} }
    expect(() => log.outcome("k1", "wo-1", retry)).toThrow(/different intent/)
    expect(() => log.begin("k1", "wo-1", retry, at)).toThrow(/different intent/)
    expect(() => log.outcome("k1", "wo-2", intent)).toThrow(/already used for work order wo-1/)
    expect(() => log.begin("k1", "wo-2", intent, at)).toThrow(/already used for work order wo-1/)
  })

  it("lists open intents for reconciliation", () => {
    const log = createCommandLog(openRegistry(":memory:").db)
    log.begin("k1", "wo-1", intent, at)
    log.begin("k2", "wo-2", { command: "approve", args: { revision: 3 } }, at)
    log.complete("k1", { ok: true, message: "done" })
    expect(log.open()).toEqual([
      {
        operationKey: "k2",
        workOrderId: "wo-2",
        intent: { command: "approve", args: { revision: 3 } },
      },
    ])
  })

  it("refuses to complete an unknown or already completed key", () => {
    const log = createCommandLog(openRegistry(":memory:").db)
    expect(() => log.complete("nope", { ok: true, message: "x" })).toThrow()
    log.begin("k1", "wo-1", intent, at)
    log.complete("k1", { ok: true, message: "x" })
    expect(() => log.complete("k1", { ok: false, message: "y" })).toThrow()
  })

  it("refuses to reuse an operation key with a different intent", () => {
    const log = createCommandLog(openRegistry(":memory:").db)
    log.begin("k", "wo-1", { command: "approve", args: { revision: 1 } }, at)
    expect(() => log.begin("k", "wo-1", { command: "approve", args: { revision: 2 } }, at)).toThrow(
      /different intent/,
    )
  })

  it("orders open intents with the same `at` by insertion order", () => {
    const log = createCommandLog(openRegistry(":memory:").db)
    log.begin("k1", "wo-1", intent, at)
    log.begin("k2", "wo-2", { command: "approve", args: { revision: 3 } }, at)
    expect(log.open().map((c) => c.operationKey)).toEqual(["k1", "k2"])
  })
})
