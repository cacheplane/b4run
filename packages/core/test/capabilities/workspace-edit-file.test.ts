import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionsStore } from "@b4run/permissions/node"
import { localExec, localFilesystem } from "@b4run/workspace/node"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createWorkspaceMarker } from "../../src/capabilities/built-in/workspace.js"
import type { B4ToolDefinition, CapabilityMarkerContext } from "../../src/capabilities/types.js"
import { nodeMarkerFs } from "../../src/node-marker-fs.js"

function ctx(
  appRoot: string,
  extras: Partial<CapabilityMarkerContext> = {},
): CapabilityMarkerContext {
  return {
    routeManifest: { appRoot, routes: [] },
    descriptor: undefined,
    appRoot,
    markerFs: nodeMarkerFs,
    backendFactories: {
      filesystem: () => localFilesystem(),
      exec: () => localExec(),
    },
    ...extras,
  }
}

function signal() {
  return { signal: new AbortController().signal }
}

let appRoot: string
let workspaceDir: string

beforeEach(() => {
  // Canonical from the start: the permission gate compares real paths, and on
  // macOS tmpdir() is a symlink into /private.
  appRoot = realpathSync(mkdtempSync(join(tmpdir(), "b4-workspace-edit-")))
  workspaceDir = join(appRoot, "workspace")
  mkdirSync(workspaceDir)
})

afterEach(() => {
  rmSync(appRoot, { recursive: true, force: true })
})

async function tool(
  name: string,
  extras: Partial<CapabilityMarkerContext> = {},
): Promise<B4ToolDefinition> {
  const contribution = await createWorkspaceMarker().load(
    join(appRoot, "route"),
    ctx(appRoot, extras),
  )
  const found = (contribution.tools ?? []).find((t) => t.name === name)
  if (!found) throw new Error(`Tool ${name} not found`)
  return found
}

function workspaceFile(name: string, content: string): string {
  const path = join(workspaceDir, name)
  writeFileSync(path, content, "utf8")
  return path
}

describe("editFile", () => {
  it("is overridable and describes itself as the way to change an existing file", async () => {
    const editFile = await tool("editFile")
    expect((editFile as unknown as { overridable?: boolean }).overridable).toBe(true)
    expect(editFile.description).toMatch(/oldText/)
    expect((await tool("writeFile")).description).toMatch(/prefer editFile/i)
    expect((await tool("readFile")).description).toMatch(/ranges.*editFile/s)
  })

  it("replaces a single occurrence and reports its line", async () => {
    const path = workspaceFile("a.ts", "const a = 1\nconst b = 2\nconst c = 3\n")
    const result = await (await tool("editFile")).run(
      { path: "a.ts", oldText: "const b = 2", newText: "const b = 20" },
      signal(),
    )
    expect(result).toBe("replaced 1 occurrence in a.ts at line 2")
    expect(readFileSync(path, "utf8")).toBe("const a = 1\nconst b = 20\nconst c = 3\n")
  })

  it("refuses when oldText is not found, leaving the file untouched", async () => {
    const path = workspaceFile("a.txt", "hello\n")
    await expect(
      (await tool("editFile")).run({ path: "a.txt", oldText: "bye", newText: "x" }, signal()),
    ).rejects.toThrow("oldText not found in a.txt")
    expect(readFileSync(path, "utf8")).toBe("hello\n")
  })

  it("refuses multiple occurrences without replaceAll, naming the count", async () => {
    const path = workspaceFile("a.txt", "x\nx\ny\nx\n")
    await expect(
      (await tool("editFile")).run({ path: "a.txt", oldText: "x", newText: "z" }, signal()),
    ).rejects.toThrow(
      "oldText occurs 3 times in a.txt; include more surrounding text or set replaceAll",
    )
    expect(readFileSync(path, "utf8")).toBe("x\nx\ny\nx\n")
  })

  it("replaces every occurrence with replaceAll and lists their lines", async () => {
    const path = workspaceFile("a.txt", "x\nx\ny\nx\n")
    const result = await (await tool("editFile")).run(
      { path: "a.txt", oldText: "x", newText: "z", replaceAll: true },
      signal(),
    )
    expect(result).toBe("replaced 3 occurrences in a.txt at lines 1, 2, 4")
    expect(readFileSync(path, "utf8")).toBe("z\nz\ny\nz\n")
  })

  it("replaceAll still refuses when there is no occurrence", async () => {
    workspaceFile("a.txt", "abc\n")
    await expect(
      (await tool("editFile")).run(
        { path: "a.txt", oldText: "q", newText: "z", replaceAll: true },
        signal(),
      ),
    ).rejects.toThrow("oldText not found in a.txt")
  })

  it("rejects an empty oldText", async () => {
    const path = workspaceFile("a.txt", "abc\n")
    await expect(
      (await tool("editFile")).run({ path: "a.txt", oldText: "", newText: "z" }, signal()),
    ).rejects.toThrow()
    expect(readFileSync(path, "utf8")).toBe("abc\n")
  })

  it("matches exactly and preserves CRLF line endings", async () => {
    const path = workspaceFile("crlf.txt", "one\r\ntwo\r\nthree\r\n")
    const editFile = await tool("editFile")
    // An LF-only oldText does not match CRLF content.
    await expect(
      editFile.run({ path: "crlf.txt", oldText: "one\ntwo", newText: "x" }, signal()),
    ).rejects.toThrow("oldText not found in crlf.txt")
    const result = await editFile.run(
      { path: "crlf.txt", oldText: "two\r\n", newText: "TWO\r\n" },
      signal(),
    )
    expect(result).toBe("replaced 1 occurrence in crlf.txt at line 2")
    expect(readFileSync(path, "utf8")).toBe("one\r\nTWO\r\nthree\r\n")
  })

  it("counts overlapping matches for uniqueness: aa in aaa is ambiguous", async () => {
    const path = workspaceFile("a.txt", "aaa")
    const editFile = await tool("editFile")
    await expect(
      editFile.run({ path: "a.txt", oldText: "aa", newText: "b" }, signal()),
    ).rejects.toThrow("oldText occurs 2 times in a.txt")
    expect(readFileSync(path, "utf8")).toBe("aaa")
    // replaceAll is non-overlapping, left to right.
    const result = await editFile.run(
      { path: "a.txt", oldText: "aa", newText: "b", replaceAll: true },
      signal(),
    )
    expect(result).toBe("replaced 1 occurrence in a.txt at line 1")
    expect(readFileSync(path, "utf8")).toBe("ba")
  })

  it("refuses a non-UTF-8 file and leaves its bytes untouched", async () => {
    const path = join(workspaceDir, "latin1.txt")
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x78, 0x0a]) // "café\nx\n" in Latin-1
    writeFileSync(path, bytes)
    await expect(
      (await tool("editFile")).run({ path: "latin1.txt", oldText: "x", newText: "y" }, signal()),
    ).rejects.toThrow(/latin1\.txt is not valid UTF-8/)
    expect(readFileSync(path).equals(bytes)).toBe(true)
  })

  it("preserves a leading UTF-8 BOM", async () => {
    const path = workspaceFile("bom.txt", "\uFEFFone\ntwo\n")
    await (await tool("editFile")).run(
      { path: "bom.txt", oldText: "two", newText: "TWO" },
      signal(),
    )
    expect(readFileSync(path, "utf8")).toBe("\uFEFFone\nTWO\n")
  })

  it("returns no change without writing when newText equals oldText", async () => {
    const backend = {
      readFile: vi.fn(),
      readBinaryFile: vi.fn().mockResolvedValue(new TextEncoder().encode("a\nb\n")),
      writeFile: vi.fn(),
      listDir: vi.fn(),
      realPath: async (p: string) => p,
    }
    const editFile = await tool("editFile", { backends: { filesystem: backend } })
    const result = await editFile.run({ path: "f.txt", oldText: "b", newText: "b" }, signal())
    expect(result).toMatch(/^no change/)
    expect(backend.writeFile).not.toHaveBeenCalled()
    // Still validated: a missing oldText is an error, not "no change".
    await expect(
      editFile.run({ path: "f.txt", oldText: "q", newText: "q" }, signal()),
    ).rejects.toThrow("oldText not found in f.txt")
  })

  it("hints at CRLF when the file uses CRLF and oldText has bare newlines", async () => {
    workspaceFile("crlf.txt", "one\r\ntwo\r\n")
    await expect(
      (await tool("editFile")).run(
        { path: "crlf.txt", oldText: "one\ntwo", newText: "x" },
        signal(),
      ),
    ).rejects.toThrow(/not found in crlf\.txt \(the file uses CRLF line endings/)
  })

  it("accepts null for replaceAll", async () => {
    const path = workspaceFile("a.txt", "x\n")
    await (await tool("editFile")).run(
      { path: "a.txt", oldText: "x", newText: "y", replaceAll: null },
      signal(),
    )
    expect(readFileSync(path, "utf8")).toBe("y\n")
  })

  it("keeps $ sequences in newText literal", async () => {
    const path = workspaceFile("a.txt", "price: X\n")
    await (await tool("editFile")).run(
      { path: "a.txt", oldText: "X", newText: "$& $1 $$" },
      signal(),
    )
    expect(readFileSync(path, "utf8")).toBe("price: $& $1 $$\n")
  })

  it("edits one line of a huge file and leaves every other byte unchanged", async () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `  line ${i + 1}: ${"x".repeat(30)}`)
    const original = `${lines.join("\n")}\n`
    const path = workspaceFile("huge.ts", original)
    const result = await (await tool("editFile")).run(
      { path: "huge.ts", oldText: "  line 2000: ", newText: "  LINE 2000: " },
      signal(),
    )
    expect(result).toBe("replaced 1 occurrence in huge.ts at line 2000")
    expect(readFileSync(path, "utf8")).toBe(original.replace("  line 2000: ", "  LINE 2000: "))
  })

  it("reads and writes through the configured backend with jailed absolute paths", async () => {
    const backend = {
      readFile: vi.fn(),
      readBinaryFile: vi.fn().mockResolvedValue(new TextEncoder().encode("a\nb\n")),
      writeFile: vi.fn().mockResolvedValue({ bytesWritten: 4 }),
      listDir: vi.fn(),
      realPath: async (p: string) => p,
    }
    const editFile = await tool("editFile", {
      backends: { filesystem: backend },
    })
    await editFile.run({ path: "f.txt", oldText: "b", newText: "c" }, signal())
    const abs = join(workspaceDir, "f.txt")
    expect(backend.readBinaryFile.mock.calls[0]?.[0]).toBe(abs)
    expect(backend.readFile).not.toHaveBeenCalled()
    expect(backend.writeFile).toHaveBeenCalledOnce()
    expect(backend.writeFile.mock.calls[0]?.slice(0, 2)).toEqual([abs, "a\nc\n"])
  })

  it("refuses a path-jail escape in non-interactive mode", async () => {
    const outside = join(appRoot, "secret.txt")
    writeFileSync(outside, "token=1\n", "utf8")
    const permissions = createPermissionsStore({
      appRoot,
      config: undefined,
      mode: "non-interactive",
    })
    await permissions.load()
    await expect(
      (await tool("editFile", { permissions })).run(
        { path: "../secret.txt", oldText: "1", newText: "2" },
        signal(),
      ),
    ).rejects.toThrow(/permission denied/i)
    expect(readFileSync(outside, "utf8")).toBe("token=1\n")
  })

  it("applies the write gate: an outside path allowed for reads but not writes is refused", async () => {
    const outsideDir = join(appRoot, "shared")
    mkdirSync(outsideDir)
    const outside = join(outsideDir, "notes.txt")
    writeFileSync(outside, "old\n", "utf8")
    const readOnly = createPermissionsStore({
      appRoot,
      config: { version: 1, allow: { readFile: [`${outsideDir}/`] }, deny: {} },
      mode: "non-interactive",
    })
    await readOnly.load()
    await expect(
      (await tool("editFile", { permissions: readOnly })).run(
        { path: "../shared/notes.txt", oldText: "old", newText: "new" },
        signal(),
      ),
    ).rejects.toThrow(/permission denied/i)
    expect(readFileSync(outside, "utf8")).toBe("old\n")

    const readWrite = createPermissionsStore({
      appRoot,
      config: {
        version: 1,
        allow: { readFile: [`${outsideDir}/`], writeFile: [`${outsideDir}/`] },
        deny: {},
      },
      mode: "non-interactive",
    })
    await readWrite.load()
    await (await tool("editFile", { permissions: readWrite })).run(
      { path: "../shared/notes.txt", oldText: "old", newText: "new" },
      signal(),
    )
    expect(readFileSync(outside, "utf8")).toBe("new\n")
  })
})

describe("readFile line ranges", () => {
  const TEN = `${Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")}\n`

  it("returns a middle range under a header naming the file's length", async () => {
    workspaceFile("ten.txt", TEN)
    const result = await (await tool("readFile")).run(
      { path: "ten.txt", startLine: 3, endLine: 5 },
      signal(),
    )
    expect(result).toBe("[ten.txt lines 3-5 of 10]\nline 3\nline 4\nline 5")
  })

  it("clamps an endLine past the end of the file", async () => {
    workspaceFile("ten.txt", TEN)
    const result = await (await tool("readFile")).run(
      { path: "ten.txt", startLine: 8, endLine: 500 },
      signal(),
    )
    expect(result).toBe("[ten.txt lines 8-10 of 10]\nline 8\nline 9\nline 10")
  })

  it("defaults the missing end of a half-open range", async () => {
    workspaceFile("ten.txt", TEN)
    const readFile = await tool("readFile")
    expect(await readFile.run({ path: "ten.txt", startLine: 10 }, signal())).toBe(
      "[ten.txt lines 10-10 of 10]\nline 10",
    )
    expect(await readFile.run({ path: "ten.txt", endLine: 2 }, signal())).toBe(
      "[ten.txt lines 1-2 of 10]\nline 1\nline 2",
    )
  })

  it("rejects startLine > endLine, a startLine past the end, and non-positive lines", async () => {
    workspaceFile("ten.txt", TEN)
    const readFile = await tool("readFile")
    await expect(
      readFile.run({ path: "ten.txt", startLine: 5, endLine: 3 }, signal()),
    ).rejects.toThrow("startLine (5) is greater than endLine (3)")
    await expect(readFile.run({ path: "ten.txt", startLine: 11 }, signal())).rejects.toThrow(
      "startLine 11 is past the end of ten.txt (10 lines)",
    )
    await expect(readFile.run({ path: "ten.txt", startLine: 0 }, signal())).rejects.toThrow()
  })

  it("keeps CRLF bytes and counts a file without a trailing newline", async () => {
    workspaceFile("crlf.txt", "a\r\nb\r\nc")
    const result = await (await tool("readFile")).run(
      { path: "crlf.txt", startLine: 2, endLine: 3 },
      signal(),
    )
    expect(result).toBe("[crlf.txt lines 2-3 of 3]\nb\r\nc")
  })

  it("treats null range fields as absent", async () => {
    workspaceFile("ten.txt", TEN)
    const readFile = await tool("readFile")
    expect(await readFile.run({ path: "ten.txt", startLine: null, endLine: null }, signal())).toBe(
      TEN,
    )
    expect(await readFile.run({ path: "ten.txt", startLine: 9, endLine: null }, signal())).toBe(
      "[ten.txt lines 9-10 of 10]\nline 9\nline 10",
    )
  })

  it("refuses a range on an empty file, naming its zero length", async () => {
    workspaceFile("empty.txt", "")
    const readFile = await tool("readFile")
    await expect(readFile.run({ path: "empty.txt", startLine: 1 }, signal())).rejects.toThrow(
      "startLine 1 is past the end of empty.txt (0 lines)",
    )
    expect(await readFile.run({ path: "empty.txt" }, signal())).toBe("")
  })

  it("without a range, returns the file exactly as stored", async () => {
    const content = "a\r\nb\n\nc\n"
    workspaceFile("raw.txt", content)
    expect(await (await tool("readFile")).run({ path: "raw.txt" }, signal())).toBe(content)
  })
})
