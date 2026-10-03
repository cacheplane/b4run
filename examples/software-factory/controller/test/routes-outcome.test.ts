import { describe, expect, it } from "vitest"
import type { Factory } from "../src/lib/controller/factory.ts"
import {
  CommandInFlightError,
  UnknownTaskError,
  UnknownWorkOrderError,
} from "../src/lib/domain/errors.ts"
import { StaleRevisionError } from "../src/lib/registry/work-orders.ts"
import { IdInput } from "../src/lib/routes/input.ts"
import { command } from "../src/lib/routes/outcome.ts"

/**
 * The refusal mapping, proved directly. Two of these classes are very hard to reach through
 * a served route — the runtime already serialises one run per thread, so a second command on
 * a busy work order is its 409 and never the Factory's `CommandInFlightError`, and a stale
 * revision needs a concurrent writer between a command's read and its compare-and-swap. They
 * are still both real: a crash leaves an operation key in flight, and the budget ticker
 * writes rows under a running command. So the mapping is tested where it lives.
 */
const factoryThatThrows =
  (error: unknown): (() => Promise<Factory>) =>
  async () =>
    ({
      dispatch: async () => {
        throw error
      },
    }) as unknown as Factory

const dispatchWith = (error: unknown) =>
  command(IdInput, { id: "wo-1" }, factoryThatThrows(error), async ({ id }, factory) =>
    factory.dispatch(id),
  )

describe("route outcomes", () => {
  it("turns a command still in flight into a refusal, not a 500", async () => {
    const outcome = await dispatchWith(new CommandInFlightError("dispatch:wo-1:0"))
    expect(outcome).toMatchObject({ ok: false, refusal: "command_in_flight" })
    expect(outcome.message).toContain("dispatch:wo-1:0")
  })

  it("turns a lost compare-and-swap into stale_revision", async () => {
    const outcome = await dispatchWith(new StaleRevisionError("wo-1", 3))
    expect(outcome).toMatchObject({ ok: false, refusal: "stale_revision" })
  })

  it("turns the unknown-task and unknown-work-order classes into their refusals", async () => {
    expect(await dispatchWith(new UnknownTaskError("nope"))).toMatchObject({
      ok: false,
      refusal: "unknown_task",
    })
    expect(await dispatchWith(new UnknownWorkOrderError("wo-1"))).toMatchObject({
      ok: false,
      refusal: "unknown_work_order",
    })
  })

  it("refuses input before it reaches the factory", async () => {
    const outcome = await command(
      IdInput,
      { nope: 1 },
      factoryThatThrows(new Error("must not be reached")),
      async () => ({ ok: true, message: "unreachable" }),
    )
    expect(outcome).toMatchObject({ ok: false, refusal: "invalid_input" })
    expect(outcome.issues?.length).toBeGreaterThan(0)
  })

  it("rethrows anything it does not recognise, so a real fault is not dressed as a refusal", async () => {
    await expect(dispatchWith(new Error("disk is on fire"))).rejects.toThrow(/disk is on fire/)
  })
})
