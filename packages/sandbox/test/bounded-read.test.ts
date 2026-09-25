import { isWorkspaceReadLimitError } from "@b4run/workspace"
import { describe, expect, it } from "vitest"
import { decodeBoundedRead } from "../src/bounded-read.ts"

describe("decodeBoundedRead", () => {
  it("throws a typed read-limit error with the historic message", () => {
    const framed = Buffer.concat([Buffer.from("abcdef"), Buffer.from("\nB4_READ_STATUS_0\n")])
    let caught: unknown
    try {
      decodeBoundedRead(framed, "/workspace/f", 3, "readBinaryFile", "")
    } catch (error) {
      caught = error
    }
    expect(isWorkspaceReadLimitError(caught)).toBe(true)
    expect((caught as Error).message).toBe(
      "readBinaryFile /workspace/f: content exceeds maxBytes (3).",
    )
  })

  it("keeps a failed read status an ordinary error", () => {
    const framed = Buffer.from("\nB4_READ_STATUS_1\n")
    expect(() => decodeBoundedRead(framed, "/w/f", 3, "readFile", "No such file")).toThrow(
      "readFile failed: No such file",
    )
    try {
      decodeBoundedRead(framed, "/w/f", 3, "readFile", "No such file")
    } catch (error) {
      expect(isWorkspaceReadLimitError(error)).toBe(false)
    }
  })
})
