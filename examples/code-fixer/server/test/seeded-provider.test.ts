import type { SandboxHandle, SandboxProvider } from "@b4run/workspace"
import { expect, it } from "vitest"
import { seededProvider } from "../src/blueprint/seeded-provider.ts"

it("seeds once, preserves reacquired edits, and destroys owned attempts", async () => {
  const acquired: string[] = [],
    destroyed: string[] = [],
    seeded: string[] = []
  const base: SandboxProvider = {
    name: "test",
    acquire: async ({ threadId }) => {
      acquired.push(threadId)
      return { threadId } as SandboxHandle
    },
    release: async () => {},
    destroy: async (id) => {
      destroyed.push(id)
    },
  }
  const provider = seededProvider(base, async (h) => {
    seeded.push(h.threadId)
  })
  const input = (threadId: string) => ({
    threadId,
    policy: { network: { mode: "deny" as const } },
    signal: new AbortController().signal,
  })
  await provider.acquire(input("one"))
  await provider.release("one")
  await provider.acquire(input("one"))
  await provider.acquire(input("two"))
  expect(seeded).toEqual(["one", "two"])
  expect(acquired).toEqual(["one", "one", "two"])
  expect(provider.handles.size).toBe(2)
  await provider.destroyAll()
  expect(destroyed).toEqual(["one", "two"])
  expect(provider.handles.size).toBe(0)
})

it("destroys a sandbox when seeding fails", async () => {
  let destroyed = false
  const base: SandboxProvider = {
    name: "test",
    acquire: async () => ({ threadId: "bad" }) as SandboxHandle,
    release: async () => {},
    destroy: async () => {
      destroyed = true
    },
  }
  const provider = seededProvider(base, async () => {
    throw new Error("seed failure")
  })
  await expect(
    provider.acquire({
      threadId: "bad",
      policy: { network: { mode: "deny" } },
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("seed failure")
  expect(destroyed).toBe(true)
  expect(provider.handles.size).toBe(0)
})
