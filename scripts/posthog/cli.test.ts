import { describe, expect, it, vi } from "vitest"
import { run } from "./cli.ts"
import type { PosthogClient } from "./client.ts"

function harness(client: PosthogClient) {
  const out: string[] = []
  const err: string[] = []
  const io = {
    stdout: (l: string) => out.push(l),
    stderr: (l: string) => err.push(l),
    env: {},
    client,
  }
  return { out, err, io }
}

describe("cli", () => {
  it("plan prints the formatted plan and exits 0", async () => {
    const get = vi.fn(async () => ({ results: [] }))
    const { out, io } = harness({ get } as unknown as PosthogClient)
    expect(await run(["plan"], io)).toBe(0)
    const text = out.join("\n")
    expect(text).toContain("[create] dashboard site-and-docs-engagement")
    expect(text).toContain("[create] dashboard cli-usage-and-activation")
    expect(text.match(/\[create\] insight/g)).toHaveLength(11)
  })

  it("plan prints nothing to do when every bucket is empty", async () => {
    const get = vi.fn(async () => ({ results: [] }))
    const { out, io } = harness({ get } as unknown as PosthogClient)
    expect(
      await run(["plan"], { ...io, root: new URL("./empty-root/", import.meta.url).pathname }),
    ).toBe(0)
    expect(out).toEqual(["nothing to do"])
  })

  it("quality exits 1 when an error finding exists", async () => {
    const get = vi.fn(async () => ({ results: [] }))
    const { out, io } = harness({ get } as unknown as PosthogClient)
    expect(await run(["quality", "--days", "3"], io)).toBe(1)
    expect(out.join("\n")).toContain("insufficient_event_coverage")
  })

  it("quality exits 0 when only warnings exist", async () => {
    const get = vi.fn(async (_p: string, q?: Record<string, string>) => ({
      results:
        q?.event === "$pageview"
          ? [{ event: "$pageview", timestamp: "t", properties: { odd: 1 } }]
          : [],
    }))
    const { io } = harness({ get } as unknown as PosthogClient)
    expect(await run(["quality"], io)).toBe(0)
  })

  it("rejects an unknown command", async () => {
    const { err, io } = harness({} as PosthogClient)
    expect(await run(["bogus"], io)).toBe(1)
    expect(err[0]).toContain("Usage")
  })
})
