import { describe, expect, it } from "vitest"
import {
  readThreadWorkspace,
  ThreadWorkspaceReadError,
} from "../src/lib/runtime/read-thread-workspace.ts"

const DIGEST = "a".repeat(64)
const OTHER = "b".repeat(64)
const good = {
  threadId: "t 1",
  sourceDigest: DIGEST,
  intentDigest: OTHER,
  root: "draft",
  inspection: { files: { "task.json": "{}" }, symlinks: {}, totalBytes: 2, entries: 1 },
}

function answering(status: number, body: unknown, seen: Request[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Request(input, init))
    return Response.json(body, { status })
  }) as typeof fetch
}

describe("readThreadWorkspace", () => {
  it("posts the options with the caller's headers and returns the verified read", async () => {
    const seen: Request[] = []
    const read = await readThreadWorkspace(
      "http://worker:4100/",
      "t 1",
      { root: "draft", maxTotalBytes: 1024 },
      {
        headers: { authorization: "Bearer x" },
        fetch: answering(200, good, seen),
        expectedSourceDigest: DIGEST,
      },
    )
    expect(read).toEqual(good)
    expect(Object.getPrototypeOf(read.inspection.files)).toBeNull()
    const request = seen[0] as Request
    expect(request.method).toBe("POST")
    expect(request.url).toBe("http://worker:4100/threads/t%201/workspace/inspect")
    expect(request.headers.get("authorization")).toBe("Bearer x")
    expect(request.redirect).toBe("error")
    expect(await request.json()).toEqual({ root: "draft", maxTotalBytes: 1024 })
  })

  it("refuses an answer larger than maxResponseBytes before holding it whole", async () => {
    await expect(
      readThreadWorkspace(
        "http://w",
        "t 1",
        {},
        { fetch: answering(200, good), maxResponseBytes: 64 },
      ),
    ).rejects.toMatchObject({ code: "response_too_large" })
  })

  it("refuses an answer about another source or another thread", async () => {
    await expect(
      readThreadWorkspace(
        "http://w",
        "t 1",
        {},
        { fetch: answering(200, good), expectedSourceDigest: OTHER },
      ),
    ).rejects.toMatchObject({ code: "source_mismatch" })
    await expect(
      readThreadWorkspace("http://w", "t 2", {}, { fetch: answering(200, good) }),
    ).rejects.toMatchObject({ code: "thread_mismatch" })
  })

  for (const [label, body] of Object.entries({
    "an extra key": { ...good, extra: 1 },
    "a bad digest": { ...good, sourceDigest: "sha256:x" },
    "a non-string file": { ...good, inspection: { ...good.inspection, files: { a: 1 } } },
    "a missing inspection": { threadId: "t 1", sourceDigest: DIGEST, intentDigest: OTHER },
    "an array": [good],
    "a file key that climbs out": {
      ...good,
      inspection: { ...good.inspection, files: { "../x": "" } },
    },
    "an absolute file key": {
      ...good,
      inspection: { ...good.inspection, files: { "/etc/passwd": "" } },
    },
    "a nested symlink key": {
      ...good,
      inspection: { ...good.inspection, symlinks: { "a/b": "/x" } },
    },
  }))
    it(`refuses a malformed answer: ${label}`, async () => {
      await expect(
        readThreadWorkspace("http://w", "t 1", {}, { fetch: answering(200, body) }),
      ).rejects.toMatchObject({ code: "malformed_response" })
    })

  it("keeps a refusal's status, code and details", async () => {
    const error = await readThreadWorkspace(
      "http://w",
      "t 1",
      { root: "draft" },
      {
        fetch: answering(422, {
          error: {
            kind: "request_error",
            message: 'Workspace root "draft" is missing',
            details: { code: "workspace_root_missing", root: "draft", kind: "absent" },
          },
        }),
      },
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ThreadWorkspaceReadError)
    expect(error).toMatchObject({
      status: 422,
      code: "workspace_root_missing",
      details: { root: "draft", kind: "absent" },
    })
  })

  it("keeps a non-JSON failure's text", async () => {
    const fetchImpl = (async () =>
      new Response("bad gateway", { status: 502 })) as unknown as typeof fetch
    await expect(
      readThreadWorkspace("http://w", "t", {}, { fetch: fetchImpl }),
    ).rejects.toMatchObject({
      status: 502,
      code: undefined,
      message: expect.stringContaining("bad gateway"),
    })
  })
})
