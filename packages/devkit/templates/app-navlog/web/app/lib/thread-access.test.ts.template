import { describe, expect, test, vi } from "vitest"
import { checkThreadAccess } from "./thread-access"

const answering = (status: number) =>
  vi.fn<typeof fetch>(async () => new Response(null, { status }))

describe("checkThreadAccess", () => {
  test("asks the thread route with the id as one encoded segment", async () => {
    const fetchImpl = answering(204)
    expect(await checkThreadAccess("t/1", undefined, fetchImpl)).toBe("open")
    expect(fetchImpl).toHaveBeenCalledWith("/api/threads/t%2F1", {})
  })

  test("only a 404 is a refusal", async () => {
    expect(await checkThreadAccess("t-1", undefined, answering(404))).toBe("refused")
    for (const status of [403, 429, 500, 502]) {
      expect(await checkThreadAccess("t-1", undefined, answering(status))).toBe("unknown")
    }
  })

  test("no connection is no answer", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed")
    })
    expect(await checkThreadAccess("t-1", undefined, fetchImpl)).toBe("unknown")
  })
})
