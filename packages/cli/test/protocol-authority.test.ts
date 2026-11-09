import type { ThreadAccessPolicy, ThreadAccessRequest } from "@b4run/sdk"
import type { Thread } from "@b4run/sqlite-storage"
import { describe, expect, it } from "vitest"
import { setRequestPrincipal } from "../src/lib/dev/auth.ts"
import { protocolRestError } from "../src/lib/dev/protocol/errors.ts"
import {
  authorizeProtocolCopy,
  authorizeProtocolRead,
  makeProtocolThreadGate,
} from "../src/lib/dev/thread-gate.ts"

const id = "00000000-0000-0000-0000-000000000001"
const thread = (status: Thread["status"]): Thread => ({
  thread_id: id,
  status,
  metadata: {},
  created_at: "2026-11-05T00:00:00Z",
  updated_at: "2026-11-05T00:00:00Z",
})
function setup(policy: ThreadAccessPolicy, authenticated = true) {
  const request = new Request("http://local/runs/search", { method: "POST" })
  if (authenticated) setRequestPrincipal(request, { id: "trusted-user" })
  return makeProtocolThreadGate(policy, request, { deploymentId: "trusted-deployment" })
}

describe("protocol authority shares the thread gate", () => {
  it.each([false, true])("freezes trusted scope for authenticated=%s", async (authenticated) => {
    let seen: ThreadAccessRequest | undefined
    const gate = setup(
      {
        fallback: (req) => {
          seen = req
          return { decision: "allow" }
        },
      },
      authenticated,
    )
    await gate({
      action: "read",
      operation: "run.get",
      threadId: id,
      provenance: { agentId: "/a#graph", namespace: ["child"], sourceThreadId: id },
    })
    expect(seen?.principal?.id).toBe(authenticated ? "trusted-user" : undefined)
    expect(seen?.context?.deploymentId).toBe("trusted-deployment")
    expect(seen?.context?.scope).toEqual(
      authenticated ? { kind: "principal", id: "trusted-user" } : { kind: "anonymous" },
    )
    expect(seen?.provenance).toEqual({
      agentId: "/a#graph",
      namespace: ["child"],
      sourceThreadId: id,
    })
    if (authenticated) expect(Object.isFrozen(seen?.principal)).toBe(true)
    expect(Object.isFrozen(seen?.context)).toBe(true)
    expect(Object.isFrozen(seen?.context?.scope)).toBe(true)
    expect(Object.isFrozen(seen?.provenance?.namespace)).toBe(true)
  })
  it("conceals policy denial body/status and active/absent/receipt state", async () => {
    for (const subject of [undefined, thread("idle"), thread("busy"), thread("interrupted")]) {
      let reads = 0
      const gate = setup({
        fallback: () => ({ decision: "deny", status: 403, body: { secret: "receipt exists" } }),
      })
      for (const operation of [
        "thread.get",
        "run.get",
        "run.receipt",
        "run.rollback",
        "run.delete",
      ] as const) {
        const result = await gate({
          action:
            operation.endsWith("delete") || operation.endsWith("rollback") ? "delete" : "read",
          operation,
          threadId: id,
          ...(subject ? { thread: subject } : {}),
        })
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.response.status).toBe(404)
          expect(await result.response.json()).toEqual({
            code: "not_found",
            message: "Resource not found",
          })
        }
      }
      await expect(
        authorizeProtocolRead({
          gate,
          spec: {
            action: "read",
            operation: "run.receipt",
            threadId: id,
            ...(subject ? { thread: subject } : {}),
          },
          read: () => {
            reads++
            return "private receipt"
          },
        }),
      ).rejects.toMatchObject({ code: "not_found" })
      expect(reads).toBe(0)
    }
  })
  it("reauthorizes every receipt disclosure and treats missing as the same public absence", async () => {
    let allowed = true,
      reads = 0,
      calls = 0
    const gate = setup({
      fallback: () => {
        calls++
        return { decision: allowed ? "allow" : "deny" }
      },
    })
    const read = () => {
      reads++
      return { receipt: "authorized" }
    }
    expect(
      await authorizeProtocolRead({
        gate,
        spec: { action: "read", operation: "run.receipt", threadId: id },
        read,
      }),
    ).toEqual({ receipt: "authorized" })
    allowed = false
    const denied = await capture(() =>
      authorizeProtocolRead({
        gate,
        spec: { action: "read", operation: "run.receipt", threadId: id },
        read,
      }),
    )
    allowed = true
    const missing = await capture(() =>
      authorizeProtocolRead({
        gate,
        spec: { action: "read", operation: "run.receipt", threadId: id },
        read: () => undefined,
      }),
    )
    expect(protocolRestError(denied)).toEqual(protocolRestError(missing))
    expect(calls).toBe(3)
    expect(reads).toBe(1)
  })
  it("authorizes copy source and destination separately before caller creates anything", async () => {
    const calls: string[] = []
    const gate = setup({
      fallback: (req) => {
        calls.push(`${req.action}:${req.operation}`)
        return { decision: req.action === "read" ? "allow" : "deny" }
      },
    })
    await expect(
      authorizeProtocolCopy({
        gate,
        source: { threadId: id, thread: thread("idle") },
        destination: { requestedMetadata: { owner: "annotation" } },
      }),
    ).rejects.toMatchObject({ code: "not_found" })
    expect(calls).toEqual(["read:thread.copy.source", "create:thread.copy.destination"])
  })
  it("does not request destination authority after source denial", async () => {
    const calls: string[] = []
    const gate = setup({
      fallback: (req) => {
        calls.push(req.operation)
        return { decision: "deny" }
      },
    })
    await expect(
      authorizeProtocolCopy({ gate, source: { threadId: id }, destination: {} }),
    ).rejects.toMatchObject({ code: "not_found" })
    expect(calls).toEqual(["thread.copy.source"])
  })
  it.each([
    "thread.search",
    "thread.patch",
    "thread.history",
    "thread.stream",
    "run.create",
    "run.search",
    "run.cancel",
    "run.rollback",
    "run.delete",
    "input.respond",
    "input.inject",
    "input.inject.system",
    "state.get",
    "state.listCheckpoints",
    "state.fork.source",
    "state.fork.destination",
    "state.update",
  ] as const)("exposes distinct operation %s", async (operation) => {
    let seen: ThreadAccessRequest | undefined
    const gate = setup({
      fallback: (req) => {
        seen = req
        return { decision: "allow" }
      },
    })
    expect((await gate({ action: "update", operation, threadId: id })).ok).toBe(true)
    expect(seen?.operation).toBe(operation)
  })
})
async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (e) {
    return e
  }
  throw new Error("Expected rejection")
}

it("passes a standard error Thread through C5 while separating its access stamp", async () => {
  let seen: ThreadAccessRequest | undefined
  const gate = setup({
    fallback: (request) => {
      seen = request
      return { decision: "allow" }
    },
  })
  const standard: import("@b4run/sdk/agent-protocol").Thread = {
    ...thread("idle"),
    status: "error",
    metadata: { "b4:access": { ownerId: "trusted-user" }, public: "caller" },
  }
  await gate({ action: "read", operation: "run.receipt", threadId: id, thread: standard })
  expect(seen?.thread?.status).toBe("error")
  expect(seen?.thread?.access).toEqual({ ownerId: "trusted-user" })
  expect(seen?.thread?.metadata).toEqual({ public: "caller" })
})
