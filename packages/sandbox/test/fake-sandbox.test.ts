import { inspectWorkspace } from "@b4run/workspace"
import { describe, expect, test } from "vitest"
import { fakeSandbox } from "../src/testing/index.ts"

const ctx = (workspaceRoot: string) => ({ signal: new AbortController().signal, workspaceRoot })

describe("fakeSandbox", () => {
  test("isolates filesystem per thread, persists across acquire (reattach)", async () => {
    const provider = fakeSandbox()
    const a1 = await provider.acquire({
      threadId: "a",
      policy: { network: { mode: "allow" } },
      signal: ctx("/x").signal,
    })
    await a1.filesystem.writeFile("/workspace/note.txt", "hello", ctx(a1.workspaceRoot))

    const a2 = await provider.acquire({
      threadId: "a",
      policy: { network: { mode: "allow" } },
      signal: ctx("/x").signal,
    })
    expect(await a2.filesystem.readFile("/workspace/note.txt", ctx(a2.workspaceRoot))).toBe("hello")

    const b = await provider.acquire({
      threadId: "b",
      policy: { network: { mode: "allow" } },
      signal: ctx("/x").signal,
    })
    expect(await b.filesystem.listDir("/workspace", ctx(b.workspaceRoot))).toEqual([])
  })

  test("release keeps the volume, destroy clears it", async () => {
    const provider = fakeSandbox()
    const h = await provider.acquire({
      threadId: "a",
      policy: { network: { mode: "allow" } },
      signal: ctx("/x").signal,
    })
    await h.filesystem.writeFile("/workspace/f", "1", ctx(h.workspaceRoot))

    await provider.release("a")
    const after = await provider.acquire({
      threadId: "a",
      policy: { network: { mode: "allow" } },
      signal: ctx("/x").signal,
    })
    expect(await after.filesystem.readFile("/workspace/f", ctx(after.workspaceRoot))).toBe("1")

    await provider.destroy("a")
    const fresh = await provider.acquire({
      threadId: "a",
      policy: { network: { mode: "allow" } },
      signal: ctx("/x").signal,
    })
    expect(await fresh.filesystem.listDir("/workspace", ctx(fresh.workspaceRoot))).toEqual([])
  })

  test("exec is scripted + records commands; runBash sees fs writes", async () => {
    const provider = fakeSandbox({
      exec: async ({ command }) => ({ stdout: `ran:${command}`, stderr: "", exitCode: 0 }),
    })
    const h = await provider.acquire({
      threadId: "a",
      policy: { network: { mode: "allow" } },
      signal: ctx("/x").signal,
    })
    const r = await h.exec.runCommand({ command: "echo hi" }, ctx(h.workspaceRoot))
    expect(r).toEqual({ stdout: "ran:echo hi", stderr: "", exitCode: 0 })
  })

  test("exposes the metadata members inspectWorkspace needs", async () => {
    const provider = fakeSandbox()
    const h = await provider.acquire({
      threadId: "a",
      policy: { network: { mode: "allow" } },
      signal: ctx("/x").signal,
    })
    await h.filesystem.writeFile("/workspace/src/a.ts", "export const a = 1\n", ctx("/workspace"))

    expect(await h.filesystem.lstat?.("/workspace/src/a.ts", ctx("/workspace"))).toEqual({
      kind: "file",
      size: 19,
      executable: false,
    })
    expect(await h.filesystem.lstat?.("/workspace/src", ctx("/workspace"))).toEqual({
      kind: "directory",
      size: 0,
      executable: false,
    })
    // An empty workspace root still inspects as a directory, not ENOENT.
    const fresh = await provider.acquire({
      threadId: "empty",
      policy: { network: { mode: "allow" } },
      signal: ctx("/x").signal,
    })
    expect(await fresh.filesystem.lstat?.("/workspace", ctx("/workspace"))).toMatchObject({
      kind: "directory",
    })
    await expect(h.filesystem.lstat?.("/workspace/absent", ctx("/workspace"))).rejects.toThrow(
      /ENOENT/,
    )

    const bytes = await h.filesystem.readBinaryFile?.("/workspace/src/a.ts", ctx("/workspace"))
    expect(new TextDecoder().decode(bytes)).toBe("export const a = 1\n")
    await expect(
      h.filesystem.readBinaryFile?.("/workspace/src/a.ts", ctx("/workspace"), { maxBytes: 3 }),
    ).rejects.toThrow(/exceeds maxBytes/)
    expect(await h.filesystem.statFile?.("/workspace/src/a.ts", ctx("/workspace"))).toMatchObject({
      size: 19,
    })
  })

  test("a workspace reader is read-only, inspectable, and closes idempotently", async () => {
    const provider = fakeSandbox()
    const h = await provider.acquire({
      threadId: "a",
      policy: { network: { mode: "allow" } },
      signal: ctx("/x").signal,
    })
    await h.filesystem.writeFile("/workspace/out.txt", "produced", ctx("/workspace"))

    const reader = await provider.openWorkspaceReader?.({
      threadId: "a",
      signal: ctx("/x").signal,
    })
    if (!reader) throw new Error("expected a reader")
    expect(reader.threadId).toBe("a")
    expect(reader.workspaceRoot).toBe("/workspace")
    expect(Object.keys(reader.filesystem).sort()).toEqual([
      "listDir",
      "lstat",
      "readBinaryFile",
      "readFile",
      "statFile",
    ])
    expect(await inspectWorkspace(reader)).toMatchObject({ files: { "out.txt": "produced" } })
    await reader.close()
    await reader.close()

    // An unknown thread has no storage, and that is an error rather than empty.
    await expect(
      provider.openWorkspaceReader?.({ threadId: "never", signal: ctx("/x").signal }),
    ).rejects.toThrow(/no workspace storage/)

    // A destroyed thread's storage is gone too.
    await provider.destroy("a")
    await expect(
      provider.openWorkspaceReader?.({ threadId: "a", signal: ctx("/x").signal }),
    ).rejects.toThrow(/no workspace storage/)
  })

  test("a workspace reader rejects an already-aborted signal", async () => {
    const provider = fakeSandbox()
    await provider.acquire({
      threadId: "a",
      policy: { network: { mode: "allow" } },
      signal: ctx("/x").signal,
    })
    const controller = new AbortController()
    controller.abort()
    await expect(
      provider.openWorkspaceReader?.({ threadId: "a", signal: controller.signal }),
    ).rejects.toThrow()
  })
})
