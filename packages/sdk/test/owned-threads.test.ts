import { describe, expect, it } from "vitest"
import {
  deny,
  ownedThreads,
  ownedThreadsOptions,
  permit,
  type ThreadAccessRequest,
  type ThreadSubject,
} from "../src/index.js"

const thread = (ownerId?: string): ThreadSubject => ({
  thread_id: "t-1",
  created_at: "2026-10-08T00:00:00.000Z",
  updated_at: "2026-10-08T00:00:00.000Z",
  status: "idle",
  metadata: {},
  access: ownerId === undefined ? undefined : { ownerId },
})

const request = (
  over: Partial<ThreadAccessRequest> & Pick<ThreadAccessRequest, "action">,
): ThreadAccessRequest => ({
  operation: "thread.get",
  threadId: "t-1",
  thread: thread("alice"),
  principal: { id: "alice" },
  method: "GET",
  url: "/threads/t-1",
  requestedMetadata: undefined,
  requestedWorkspace: undefined,
  resuming: false,
  ...over,
})

type Admin = { readonly id: string; readonly isAdmin: boolean }
const policy = ownedThreads<Admin>({ adminsRead: (principal) => principal.isAdmin })
const admin = { id: "root", isAdmin: true }

describe("ownedThreads", () => {
  it("stamps a created thread with its owner, and refuses an anonymous create", async () => {
    expect(await policy.create?.(request({ action: "create", thread: undefined }))).toEqual(
      permit({ ownerId: "alice" }),
    )
    expect(
      await policy.create?.(request({ action: "create", thread: undefined, principal: undefined })),
    ).toEqual(deny())
  })

  it("lets the owner do anything and anyone else nothing", async () => {
    for (const action of ["read", "update", "delete"] as const) {
      expect(await policy.fallback(request({ action }))).toEqual(permit())
      expect(await policy.fallback(request({ action, principal: { id: "bob" } }))).toEqual(deny())
      expect(await policy.fallback(request({ action, principal: undefined }))).toEqual(deny())
    }
  })

  it("lets an admin read, and only read, another caller's thread", async () => {
    expect(await policy.fallback(request({ action: "read", principal: admin }))).toEqual(permit())
    expect(await policy.fallback(request({ action: "update", principal: admin }))).toEqual(deny())
    expect(await policy.fallback(request({ action: "delete", principal: admin }))).toEqual(deny())
  })

  it("denies a missing row before any admin branch, so 'never existed' looks like 'not yours'", async () => {
    for (const action of ["read", "delete"] as const) {
      expect(
        await policy.fallback(request({ action, thread: undefined, principal: admin })),
      ).toEqual(deny())
    }
  })

  it("leaves a thread with no stamp to admins only", async () => {
    expect(await policy.fallback(request({ action: "read", thread: thread() }))).toEqual(deny())
    expect(
      await policy.fallback(request({ action: "read", thread: thread(), principal: admin })),
    ).toEqual(permit())
  })

  it("checks a custom owner id, and admits no admin by default", async () => {
    const byOrg = ownedThreads<{ readonly id: string; readonly org: string }>({
      owner: (principal) => principal.org,
    })
    const req = (principal: { id: string; org: string }) =>
      request({ action: "read", thread: thread("acme"), principal })
    expect(await byOrg.fallback(req({ id: "u-1", org: "acme" }))).toEqual(permit())
    expect(await byOrg.fallback(req({ id: "u-2", org: "other" }))).toEqual(deny())
    expect(await ownedThreads().fallback(request({ action: "read", principal: admin }))).toEqual(
      deny(),
    )
  })

  it("carries its options for a build target to recognize, and only on its own policies", () => {
    expect(ownedThreadsOptions(policy)?.adminsRead).toBeTypeOf("function")
    expect(Object.keys(policy).sort()).toEqual(["create", "fallback"])
    expect(ownedThreadsOptions({ fallback: () => permit() })).toBeUndefined()
  })
})
