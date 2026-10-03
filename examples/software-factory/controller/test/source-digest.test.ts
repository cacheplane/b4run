import { describe, expect, it } from "vitest"
import { handedSourceDigest } from "../src/lib/controller/source-digest.ts"

const A = "a".repeat(64)
const B = "b".repeat(64)
const events = (...list: [string, Record<string, unknown>][]) =>
  list.map(([type, payload]) => ({ type, payload }))

describe("handedSourceDigest", () => {
  it("is the digest written just before the thread that holds it was created", () => {
    const log = events(
      ["builder_manifest_written", { sourceDigest: A }],
      ["thread_created", { threadId: "t-1" }],
      ["builder_manifest_written", { sourceDigest: B }],
      ["thread_created", { threadId: "t-2" }],
    )
    expect(handedSourceDigest(log, "t-1", "builder")).toBe(A)
    expect(handedSourceDigest(log, "t-2", "builder")).toBe(B)
  })

  it("is not a later write whose thread creation failed", () => {
    const log = events(
      ["builder_manifest_written", { sourceDigest: A }],
      ["thread_created", { threadId: "t-1" }],
      ["builder_manifest_written", { sourceDigest: B }],
    )
    expect(handedSourceDigest(log, "t-1", "builder")).toBe(A)
  })

  it("reads a staged upload's digest exactly as a manifest's", () => {
    const log = events(
      ["builder_manifest_written", { sourceDigest: A }],
      ["thread_created", { threadId: "t-1" }],
      ["builder_source_staged", { sourceDigest: B, status: "created" }],
      ["thread_created", { threadId: "t-2" }],
    )
    expect(handedSourceDigest(log, "t-1", "builder")).toBe(A)
    expect(handedSourceDigest(log, "t-2", "builder")).toBe(B)
  })

  it("reads the drafter's events for a drafter thread, and never the builder's", () => {
    const log = events(
      ["drafter_manifest_written", { sourceDigest: A }],
      ["intake_thread_created", { threadId: "t-d" }],
      ["builder_manifest_written", { sourceDigest: B }],
      ["thread_created", { threadId: "t-b" }],
    )
    expect(handedSourceDigest(log, "t-d", "drafter")).toBe(A)
    expect(handedSourceDigest(log, "t-b", "builder")).toBe(B)
    expect(() => handedSourceDigest(log, "t-b", "drafter")).toThrow(/thread t-b/)
  })

  it("refuses when nothing was handed to that thread", () => {
    expect(() =>
      handedSourceDigest(events(["thread_created", { threadId: "t-1" }]), "t-1", "builder"),
    ).toThrow(/No builder source digest is journalled for thread t-1/)
    expect(() => handedSourceDigest([], "t-9", "builder")).toThrow(/thread t-9/)
  })

  it("refuses a journalled digest that is not one", () => {
    const log = events(
      ["builder_manifest_written", { sourceDigest: "not-a-digest" }],
      ["thread_created", { threadId: "t-1" }],
    )
    expect(() => handedSourceDigest(log, "t-1", "builder")).toThrow(/thread t-1/)
  })
})
