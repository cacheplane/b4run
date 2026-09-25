import { describe, expect, it } from "vitest"
import { threadPolicy } from "../src/lib/runtime/thread-policy.ts"

describe("threadPolicy", () => {
  const app = {
    network: { mode: "allow" as const, denylist: ["169.254.169.254"] },
    env: { A: "1", B: "2" },
    resources: { memoryMb: 1024, timeoutMs: 60_000 },
    security: { runAsNonRoot: true },
  }
  it("is the app's policy when the thread set nothing", () => {
    expect(threadPolicy(app, undefined)).toBe(app)
    expect(threadPolicy(app, {})).toEqual(app)
  })
  it("merges resources key by key, the thread's keys winning", () => {
    expect(threadPolicy(app, { resources: { memoryMb: 4096, cpus: 2 } }).resources).toEqual({
      memoryMb: 4096,
      cpus: 2,
      timeoutMs: 60_000,
    })
  })
  it("replaces env whole", () => {
    expect(threadPolicy(app, { env: { C: "3" } }).env).toEqual({ C: "3" })
  })
  it("keeps the app's network object, denylist included, when the thread asks for the same mode", () => {
    expect(threadPolicy(app, { network: { mode: "allow" } }).network).toBe(app.network)
  })
  it("narrows an allowed network to deny", () => {
    expect(threadPolicy(app, { network: { mode: "deny" } }).network).toEqual({ mode: "deny" })
  })
  it("refuses to open a network the app denies", () => {
    expect(() =>
      threadPolicy({ ...app, network: { mode: "deny" } }, { network: { mode: "allow" } }),
    ).toThrow(/may not open the network/)
  })
  it("never takes security from the thread", () => {
    expect(threadPolicy(app, { resources: { cpus: 1 } }).security).toBe(app.security)
  })
})
