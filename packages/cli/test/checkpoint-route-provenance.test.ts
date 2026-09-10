import { emptyCheckpoint, MemorySaver } from "@langchain/langgraph-checkpoint"
import { describe, expect, it } from "vitest"
import {
  checkpointRoutes,
  routeCheckpointer,
} from "../src/lib/runtime/checkpoint-route-provenance.js"

const config = { configurable: { thread_id: "t", checkpoint_ns: "" } }
const metadata = { source: "input" as const, step: -1, parents: {} }

describe("checkpoint route provenance", () => {
  it("overwrites forged ownership, binds it to the exact checkpoint, and carries verified parent routes", async () => {
    const saver = new MemorySaver()
    const admin = routeCheckpointer(saver, "/admin#agent")
    const first = emptyCheckpoint()
    const forged = {
      ...metadata,
      "b4:checkpoint-routes": { checkpointId: first.id, routes: ["/public#agent"] },
    }
    const parent = await admin.put(config, first, forged, {})
    const firstTuple = await saver.getTuple(parent)
    expect(checkpointRoutes(firstTuple)).toEqual(["/admin#agent"])
    const publicSaver = routeCheckpointer(saver, "/public#agent")
    const second = { ...emptyCheckpoint(), id: "second" }
    const secondConfig = await publicSaver.put(parent, second, metadata, {})
    expect(checkpointRoutes(await saver.getTuple(secondConfig))).toEqual([
      "/admin#agent",
      "/public#agent",
    ])
    expect(checkpointRoutes({ ...firstTuple!, checkpoint: second })).toBeUndefined()
  })

  it("does not wash unknown parent provenance clean by running a different route", async () => {
    const saver = new MemorySaver()
    const parent = await saver.put(config, emptyCheckpoint(), metadata)
    const publicSaver = routeCheckpointer(saver, "/public#agent")
    const child = await publicSaver.put(parent, { ...emptyCheckpoint(), id: "child" }, metadata, {})
    expect(checkpointRoutes(await saver.getTuple(child))).toBeUndefined()
  })

  it("requires an own stamp with valid own fields", () => {
    const checkpoint = emptyCheckpoint()
    const stamp = { checkpointId: checkpoint.id, routes: ["/admin#agent"] }
    const tuple = {
      config,
      checkpoint,
      metadata: Object.assign(Object.create({ "b4:checkpoint-routes": stamp }), metadata),
    }
    expect(checkpointRoutes(tuple)).toBeUndefined()
    const inheritedFields = { ...metadata, "b4:checkpoint-routes": Object.create(stamp) }
    expect(checkpointRoutes({ ...tuple, metadata: inheritedFields })).toBeUndefined()
  })

  it("preserves cached saver identity and private-field method/getter binding for custom savers", async () => {
    class CustomSaver extends MemorySaver {
      #value = "custom"
      get customValue() {
        return this.#value
      }
      customMethod() {
        return this.#value
      }
    }
    const saver = new CustomSaver()
    const wrapped = routeCheckpointer(saver, "/admin#agent") as CustomSaver
    expect(routeCheckpointer(saver, "/admin#agent")).toBe(wrapped)
    expect(routeCheckpointer(saver, "/public#agent")).not.toBe(wrapped)
    expect(wrapped.customValue).toBe("custom")
    expect(wrapped.customMethod()).toBe("custom")
    const written = await wrapped.put(config, emptyCheckpoint(), metadata)
    expect(await wrapped.getTuple(written)).toEqual(await saver.getTuple(written))
    expect(wrapped.serde).toBe(saver.serde)
  })
})
