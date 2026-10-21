import { describe, expect, it, vi } from "vitest"
import {
  OFFLOAD_FAILURE_PREVIEW_CHARS,
  offloadToolOutput,
} from "../src/offload/offload-tool-output.js"

function fakeStore(rel = "tool-outputs/x-1-a.txt") {
  return { write: vi.fn(async () => rel) }
}

describe("offloadToolOutput", () => {
  const base = { toolName: "search", thresholdChars: 40_000, previewLines: 10 }

  it("returns content unchanged when under threshold", async () => {
    const store = fakeStore()
    const out = await offloadToolOutput("small", { ...base, store: store as never })
    expect(out).toBe("small")
    expect(store.write).not.toHaveBeenCalled()
  })

  it("writes and returns a stub when over threshold", async () => {
    const store = fakeStore("tool-outputs/search-1-a.txt")
    const signal = new AbortController().signal
    const big = "x".repeat(40_001)
    const out = await offloadToolOutput(big, { ...base, signal, store: store as never })
    expect(store.write).toHaveBeenCalledWith("search", big, undefined, signal)
    expect(out).toContain("Tool output offloaded")
    expect(out).toContain("tool-outputs/search-1-a.txt")
  })

  it("fails closed with a bounded stub, never the full content, when the store write throws", async () => {
    const store = {
      write: vi.fn(async () => {
        throw new Error(
          "Path is outside the workspace: /Users/someone/app/workspace/tool-outputs/x.txt",
        )
      }),
    }
    const onError = vi.fn()
    const lines = Array.from({ length: 200_000 }, (_, i) => `match ${i}`)
    const big = `${lines.join("\n")}\nTAIL-MARKER`
    const out = await offloadToolOutput(big, { ...base, store: store as never, onError })
    expect(out).not.toBe(big)
    expect(out).not.toContain("TAIL-MARKER")
    expect(out.length).toBeLessThan(OFFLOAD_FAILURE_PREVIEW_CHARS + 1_000)
    expect(out).toContain("match 0")
    expect(out).toContain("match 9")
    expect(out).not.toContain("match 10\n")
    expect(out).toMatch(/offload(ing)? failed/i)
    expect(out).toContain("Path is outside the workspace")
    expect(out).toContain(
      `truncated to ${OFFLOAD_FAILURE_PREVIEW_CHARS.toLocaleString("en-US")} chars`,
    )
    // The error's message rides along, but never a host path outside the workspace.
    expect(out).not.toContain("/Users/someone")
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]?.[0])).toContain("Path is outside the workspace")
    expect(String(onError.mock.calls[0]?.[0])).not.toContain("/Users/someone")
  })

  it("bounds the failure stub even for a single giant line", async () => {
    const store = {
      write: vi.fn(async () => {
        throw new Error("disk full")
      }),
    }
    const big = "x".repeat(2_000_000)
    const out = await offloadToolOutput(big, { ...base, store: store as never })
    expect(out.length).toBeLessThan(OFFLOAD_FAILURE_PREVIEW_CHARS + 1_000)
    expect(out).toContain("disk full")
  })

  it("forwards toolCallId to store.write", async () => {
    const calls: Array<[string, string, string | undefined, AbortSignal | undefined]> = []
    const store = {
      write: async (
        toolName: string,
        content: string,
        toolCallId?: string,
        signal?: AbortSignal,
      ) => {
        calls.push([toolName, content, toolCallId, signal])
        return `tool-outputs/${toolName}-${toolCallId}.txt`
      },
    }
    const big = "z".repeat(50)
    const signal = new AbortController().signal
    const out = await offloadToolOutput(big, {
      toolName: "generateReport",
      thresholdChars: 10,
      previewLines: 2,
      signal,
      store,
      toolCallId: "call_xyz",
    })
    expect(calls[0]).toEqual(["generateReport", big, "call_xyz", signal])
    expect(out).toContain("tool-outputs/generateReport-call_xyz.txt")
  })
})
