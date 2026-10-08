import { describe, expect, it } from "vitest"
import { forwardIdentity } from "../src/forward-identity.ts"

/** A fetch that records the headers each call carried. */
function recorder() {
  const seen: Headers[] = []
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers))
    return new Response("ok")
  }) as typeof fetch
  return { fetchImpl, seen }
}

describe("forwardIdentity", () => {
  it("strips browser-sent identity headers and sets the current caller's", async () => {
    const { fetchImpl, seen } = recorder()
    let caller: string | undefined = "v-alice123"
    const guarded = forwardIdentity({
      fetch: fetchImpl,
      headers: ["X-B4-Visitor", "x-internal-token"],
      resolve: () =>
        caller === undefined ? undefined : { "x-b4-visitor": caller, "x-internal-token": "secret" },
    })
    await guarded("https://b4.test/agui/x", {
      headers: {
        "x-b4-visitor": "v-forged",
        "x-internal-token": "guess",
        accept: "text/event-stream",
      },
    })
    expect(seen[0]?.get("x-b4-visitor")).toBe("v-alice123")
    expect(seen[0]?.get("x-internal-token")).toBe("secret")
    expect(seen[0]?.get("accept")).toBe("text/event-stream")

    // No caller: nothing forged survives, and nothing is invented.
    caller = undefined
    await guarded("https://b4.test/agui/x", { headers: { "x-b4-visitor": "v-forged" } })
    expect(seen[1]?.has("x-b4-visitor")).toBe(false)
    expect(seen[1]?.has("x-internal-token")).toBe(false)
  })

  it("resolves per call, so a shared agent sends each request's own caller", async () => {
    const { fetchImpl, seen } = recorder()
    let caller = "v-first"
    const guarded = forwardIdentity({
      fetch: fetchImpl,
      headers: ["x-b4-visitor"],
      resolve: () => ({ "x-b4-visitor": caller }),
    })
    await guarded("https://b4.test/a")
    caller = "v-second"
    await guarded("https://b4.test/b")
    expect(seen.map((headers) => headers.get("x-b4-visitor"))).toEqual(["v-first", "v-second"])
  })

  it("refuses a resolved header it was not told to strip", async () => {
    const { fetchImpl } = recorder()
    const guarded = forwardIdentity({
      fetch: fetchImpl,
      headers: ["x-b4-visitor"],
      resolve: () => ({ "x-b4-visitor": "v-a", authorization: "Bearer t" }),
    })
    await expect(async () => guarded("https://b4.test/a")).rejects.toThrow(
      /not one of the declared/,
    )
  })

  it("keeps a Request input's own headers when no init is given", async () => {
    const { fetchImpl, seen } = recorder()
    const guarded = forwardIdentity({
      fetch: fetchImpl,
      headers: ["x-b4-visitor"],
      resolve: () => ({ "x-b4-visitor": "v-a" }),
    })
    await guarded(new Request("https://b4.test/a", { headers: { accept: "application/json" } }))
    expect(seen[0]?.get("accept")).toBe("application/json")
    expect(seen[0]?.get("x-b4-visitor")).toBe("v-a")
  })

  it("needs at least one header", () => {
    expect(() => forwardIdentity({ headers: [], resolve: () => undefined })).toThrow(/at least one/)
  })
})
