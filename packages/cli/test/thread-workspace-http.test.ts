import { describe, expect, it } from "vitest"
import {
  INSPECT_RESPONSE_MAX_BYTES,
  threadWorkspaceResponse,
} from "../src/lib/dev/thread-workspace-http.ts"
import type { ThreadWorkspaceInspectRequest } from "../src/lib/runtime/workspace-protocol.ts"

const request: ThreadWorkspaceInspectRequest = {
  excludeRootDirectories: [],
  expectedRootSymlinks: {},
  ignorePrefixes: [],
  maxEntries: 10_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
}
const outcome = (files: Record<string, string>) =>
  ({
    ok: true,
    sourceDigest: "a".repeat(64),
    intentDigest: "b".repeat(64),
    inspection: { files, symlinks: {}, totalBytes: 0, entries: Object.keys(files).length },
  }) as const

describe("threadWorkspaceResponse", () => {
  it("measures the serialized answer: escaped control characters count six bytes each", async () => {
    // 12 MiB of U+0001 is within every read limit, and serializes to 72 MiB of `\u0001`.
    const response = threadWorkspaceResponse(
      "t",
      request,
      outcome({ "a.txt": "\u0001".repeat(12 * 1024 * 1024) }),
    )
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      error: {
        details: { code: "workspace_response_too_large", maxBytes: INSPECT_RESPONSE_MAX_BYTES },
      },
    })
  })

  it("measures UTF-8 bytes, not string length: a multibyte answer over the cap in bytes only", async () => {
    // U+20AC is one UTF-16 unit and three UTF-8 bytes: 24 Mi of them is a string of
    // 24 Mi units (under the 64 MiB cap) that encodes to 72 MiB (over it).
    const text = "\u20ac".repeat(24 * 1024 * 1024)
    expect(text.length).toBeLessThan(INSPECT_RESPONSE_MAX_BYTES)
    const response = threadWorkspaceResponse("t", request, outcome({ "a.txt": text }))
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      error: { details: { code: "workspace_response_too_large" } },
    })
  })

  it("answers an inventory under the cap with its exact byte length", async () => {
    const response = threadWorkspaceResponse("t", request, outcome({ "é.txt": "héllo" }))
    expect(response.status).toBe(200)
    const bytes = new Uint8Array(await response.clone().arrayBuffer())
    expect(response.headers.get("content-type")).toMatch(/^application\/json/)
    expect(JSON.parse(new TextDecoder().decode(bytes)).inspection.files).toEqual({
      "é.txt": "héllo",
    })
  })
})
