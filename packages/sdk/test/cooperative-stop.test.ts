import { expect, it } from "vitest"
import { CooperativeStopError, isCooperativeStop } from "../src/cooperative-stop.ts"

it("distinguishes an owned cooperative outcome from an independent error", () => {
  const stopped = new CooperativeStopError("first Stop reason")
  expect(stopped.message).toBe("first Stop reason")
  expect(isCooperativeStop(stopped)).toBe(true)
  expect(isCooperativeStop(new Error("Run stopped"))).toBe(false)
  const ordinary = new Error("independent failure")
  ordinary.name = "CooperativeStopError"
  expect(isCooperativeStop(ordinary)).toBe(false)
})
