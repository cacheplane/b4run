import { describe, expect, it } from "vitest"
import { readSandboxFiles, walkSandboxTree } from "../src/batch-read.ts"

// The shell commands themselves run against a real container in the Docker lane
// (docker-sandbox.integration.test.ts, "batched workspace inspection"). These pin the
// host-side framing: what the parser accepts, and everything it must refuse.

const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 })
const walkOutput = (raw: Buffer | string) => ok(Buffer.from(raw).toString("base64"))
const block = (entries: { stat: string; path: string; target?: string }[]) =>
  `${entries.length}\n${entries.map((e) => `${e.stat}\n`).join("")}${entries
    .map((e) => `${e.path}\0`)
    .join("")}${entries.map((e) => `${e.target ?? ""}\0`).join("")}`
const footer = (status = 0) => `B4_WALK_STATUS_${status}\n`

describe("walkSandboxTree", () => {
  it("parses blocks of stat lines, NUL-terminated paths and link targets", async () => {
    const commands: string[] = []
    const out = walkOutput(
      block([
        { stat: "41ed 4096", path: "/workspace/src" },
        { stat: "81a4 5", path: "/workspace/src/new\nline.ts" },
      ]) +
        block([
          { stat: "a1ff 9", path: "/workspace/deps", target: "/opt/deps" },
          { stat: "81ed 3", path: "/workspace/café" },
        ]) +
        footer(),
    )
    const entries = await walkSandboxTree(
      "/workspace/",
      { maxEntries: 10, prune: [".git"] },
      async (c) => {
        commands.push(c)
        return out
      },
    )
    expect(entries).toEqual([
      { path: "src", kind: "directory", size: 4096, executable: true },
      { path: "src/new\nline.ts", kind: "file", size: 5, executable: false },
      { path: "deps", kind: "symlink", size: 9, executable: true, target: "/opt/deps" },
      { path: "café", kind: "file", size: 3, executable: true },
    ])
    expect(commands).toHaveLength(1)
    // The pruned name is matched literally, character by character, below the walked root only.
    expect(commands[0]).toContain(`-path '\\/\\w\\o\\r\\k\\s\\p\\a\\c\\e\\/\\.\\g\\i\\t'`)
    expect(commands[0]).toContain("find '/workspace' -mindepth 1")
  })

  it("returns nothing for an empty tree and walks the filesystem root", async () => {
    const commands: string[] = []
    expect(
      await walkSandboxTree("/", { maxEntries: 1 }, async (c) => {
        commands.push(c)
        return walkOutput(footer())
      }),
    ).toEqual([])
    expect(commands[0]).toContain("find '/' -mindepth 1 -exec")
  })

  it("refuses a failed walk, a truncated walk and a walk over the entry limit", async () => {
    const one = block([{ stat: "81a4 1", path: "/w/a" }])
    await expect(
      walkSandboxTree("/w", { maxEntries: 5 }, async () => ({
        ...walkOutput(one + footer(1)),
        stderr: "find: permission denied",
      })),
    ).rejects.toThrow(/permission denied/)
    await expect(
      walkSandboxTree("/w", { maxEntries: 5 }, async () => walkOutput(one)),
    ).rejects.toThrow(/Invalid walkTree response/)
    await expect(
      walkSandboxTree("/w", { maxEntries: 0 }, async () => walkOutput(one + footer())),
    ).rejects.toThrow(/entries limit/)
    // Output past the in-sandbox byte cap is the walk being cut off: an entry-limit failure.
    await expect(
      walkSandboxTree("/w", { maxEntries: 0 }, async () => walkOutput("x".repeat(9000))),
    ).rejects.toThrow(/entries limit/)
    await expect(
      walkSandboxTree("/w", { maxEntries: 5 }, async () => ({
        stdout: "",
        stderr: "boom",
        exitCode: 1,
      })),
    ).rejects.toThrow(/boom/)
  })

  it("refuses paths outside the walked root and malformed blocks", async () => {
    for (const raw of [
      block([{ stat: "81a4 1", path: "/elsewhere/a" }]) + footer(),
      block([{ stat: "81a4 1", path: "/w/" }]) + footer(),
      block([{ stat: "81a4 1", path: "/wx" }]) + footer(),
      `2\n81a4 1\n/w/a\0\0${footer()}`,
      `1\nnot-a-stat\n/w/a\0\0${footer()}`,
      `0\n${footer()}`,
      `1\n81a4 99999999999999999999\n/w/a\0\0${footer()}`,
    ]) {
      await expect(
        walkSandboxTree("/w", { maxEntries: 5 }, async () => walkOutput(raw)),
      ).rejects.toThrow(/Invalid/)
    }
  })

  it("refuses invalid limits and prune names before running anything", async () => {
    const never = async () => {
      throw new Error("ran")
    }
    await expect(walkSandboxTree("/w", { maxEntries: -1 }, never)).rejects.toThrow(/limit/)
    await expect(walkSandboxTree("relative", { maxEntries: 1 }, never)).rejects.toThrow(/absolute/)
    for (const name of ["", "a/b", "a\0b"])
      await expect(walkSandboxTree("/w", { maxEntries: 1, prune: [name] }, never)).rejects.toThrow(
        /prune/,
      )
  })
})

const framed = (content: string, status = 0) =>
  `${Buffer.from(`${content}\nB4_READ_STATUS_${status}\n`).toString("base64")}\n#\n`

describe("readSandboxFiles", () => {
  it("reads files in request order, splitting large batches across execs", async () => {
    const requests = Array.from({ length: 800 }, (_, i) => ({
      path: `/workspace/${"long-directory-name/".repeat(4)}file-${i}.txt`,
      maxBytes: 10,
    }))
    const scripts: string[] = []
    const result = await readSandboxFiles(requests, async (script) => {
      scripts.push(script)
      const paths = [...script.matchAll(/< '([^']+)'/g)].map((m) => m[1] as string)
      return ok(paths.map((path) => framed(path.slice(-8))).join(""))
    })
    expect(scripts.length).toBeGreaterThan(1)
    for (const script of scripts) expect(script.length).toBeLessThanOrEqual(96 * 1024)
    expect(result).toHaveLength(800)
    expect(Buffer.from(result[799] as Uint8Array).toString()).toBe("-799.txt")
    expect(Buffer.from(result[0] as Uint8Array).toString()).toBe("le-0.txt")
  })

  it("sizes read batches in bytes, so non-ASCII paths stay under the argv cap", async () => {
    const requests = Array.from({ length: 400 }, (_, i) => ({
      path: `/workspace/${"日本語のディレクトリ/".repeat(6)}ファイル-${i}.txt`,
      maxBytes: 10,
    }))
    const scripts: string[] = []
    await readSandboxFiles(requests, async (script) => {
      scripts.push(script)
      const count = [...script.matchAll(/< '/g)].length
      return ok(framed("x").repeat(count))
    })
    expect(scripts.length).toBeGreaterThan(1)
    for (const script of scripts) expect(Buffer.byteLength(script)).toBeLessThanOrEqual(96 * 1024)
  })

  it("keeps readBinaryFile's per-file bound and status checks", async () => {
    await expect(
      readSandboxFiles([{ path: "/w/a", maxBytes: 2 }], async () => ok(framed("abc"))),
    ).rejects.toThrow(/exceeds maxBytes/)
    await expect(
      readSandboxFiles([{ path: "/w/a", maxBytes: 2 }], async () => ({
        ...ok(framed("", 1)),
        stderr: "No such file",
      })),
    ).rejects.toThrow(/No such file/)
    await expect(
      readSandboxFiles([{ path: "/w/a", maxBytes: -1 }], async () => ok("")),
    ).rejects.toThrow(/maxBytes/)
  })

  it("refuses a response with the wrong number of files", async () => {
    const two = [
      { path: "/w/a", maxBytes: 5 },
      { path: "/w/b", maxBytes: 5 },
    ]
    await expect(readSandboxFiles(two, async () => ok(framed("a")))).rejects.toThrow(/Invalid/)
    await expect(
      readSandboxFiles(two, async () => ok(framed("a") + framed("b") + framed("c"))),
    ).rejects.toThrow(/Invalid/)
  })

  it("runs nothing for no requests", async () => {
    expect(
      await readSandboxFiles([], async () => {
        throw new Error("ran")
      }),
    ).toEqual([])
  })
})
