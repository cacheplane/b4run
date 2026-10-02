import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  blobId,
  changedTreeId,
  directoriesOf,
  type GitTreeEntry,
  readPinListings,
  treeId,
} from "../src/lib/delivery/git-objects.ts"

let repo: string | undefined
afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true })
  repo = undefined
})

/** git, isolated from the developer's config, in a fresh repository. */
const git = (...args: string[]): string =>
  execFileSync("git", ["-C", repo as string, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim()

function write(path: string, text: string): void {
  const absolute = join(repo as string, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, text)
}

/** `git ls-tree <sha>` as GitHub's non-recursive `git/trees/<sha>` reports it. */
const lsTree = async (sha: string): Promise<GitTreeEntry[]> =>
  git("ls-tree", "-z", sha)
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const [meta, name] = line.split("\t") as [string, string]
      const [mode, type, id] = meta.split(" ") as [string, GitTreeEntry["type"], string]
      return { name, mode: mode === "040000" ? "040000" : mode, type, sha: id }
    })

function fixture(): string {
  repo = mkdtempSync(join(tmpdir(), "git-objects-"))
  git("init", "-q", "-b", "main")
  write("README.md", "# fixture\n")
  write("packages/devkit/src/testing/process.ts", "export const deadline = 'leaks'\n")
  write("packages/devkit/src/testing/process-utils.ts", "x\n")
  write("packages/devkit/src/testing.ts", "export * from './testing/process.js'\n")
  write("packages/devkit-extra/a.ts", "a\n")
  write("packages/z.ts", "é and ✓\n")
  write("bin/run.sh", "#!/bin/sh\n")
  chmodSync(join(repo, "bin/run.sh"), 0o755)
  symlinkSync("README.md", join(repo, "LINK"))
  git("add", "-A")
  git("commit", "-q", "-m", "pin")
  return git("rev-parse", "HEAD")
}

describe("git object ids", () => {
  it("computes a blob id exactly as git hash-object does, for multibyte text too", () => {
    fixture()
    for (const text of ["", "a\n", "é and ✓\n", "no newline"]) {
      write("probe", text)
      expect(blobId(text)).toBe(git("hash-object", "probe"))
    }
  })

  it("computes a tree id exactly as git does, in git's order, with every mode", async () => {
    const pin = fixture()
    for (const path of ["", "packages", "packages/devkit/src"]) {
      const sha = git("rev-parse", `${pin}:${path}`)
      expect(treeId(await lsTree(sha))).toBe(sha)
    }
  })

  it("predicts the root tree a change produces, before anything is written", async () => {
    const pin = fixture()
    const changes = {
      "packages/devkit/src/testing/process.ts": "export const deadline = 'cleared'\n",
      "packages/z.ts": "é, ✓ and more\n",
      "bin/run.sh": "#!/bin/sh\nexit 0\n",
    }
    const read = await readPinListings(
      git("rev-parse", `${pin}^{tree}`),
      Object.keys(changes),
      lsTree,
    )
    if (!read.ok) throw new Error(read.problems.join("; "))
    expect(read.entries.get("bin/run.sh")?.mode).toBe("100755")
    expect(read.entries.get("packages/z.ts")?.sha).toBe(blobId("é and ✓\n"))
    const predicted = changedTreeId(
      read.listings,
      new Map(Object.entries(changes).map(([path, text]) => [path, blobId(text)])),
    )
    for (const [path, text] of Object.entries(changes)) write(path, text)
    git("commit", "-q", "-am", "change")
    expect(predicted).toBe(git("rev-parse", "HEAD^{tree}"))
    // The executable bit is the pin's: the change kept it.
    expect(git("ls-tree", "HEAD", "bin/run.sh")).toMatch(/^100755 /)
  })

  it("names every path the pin cannot take the change at, and reads nothing it need not", async () => {
    const pin = fixture()
    const reads: string[] = []
    const result = await readPinListings(
      git("rev-parse", `${pin}^{tree}`),
      ["LINK", "packages/nope.ts", "missing/dir/file.ts", "README.md/x"],
      async (sha) => {
        reads.push(sha)
        return lsTree(sha)
      },
    )
    expect(result).toEqual({
      ok: false,
      problems: [
        "README.md is not a directory at the pin",
        "missing is not a directory at the pin",
        "LINK is not a regular file at the pin (mode 120000)",
        "packages/nope.ts does not exist at the pin",
      ],
    })
    expect(reads).toHaveLength(2) // the root and packages/, never the whole repository
  })

  it("refuses a listing that is not the tree it was read from", async () => {
    const pin = fixture()
    const root = git("rev-parse", `${pin}^{tree}`)
    const packages = git("rev-parse", `${pin}:packages`)
    const tampered = await readPinListings(root, ["packages/z.ts"], async (sha) => {
      const listing = await lsTree(sha)
      return sha === packages
        ? listing.map((e) => (e.name === "z.ts" ? { ...e, sha: blobId("other\n") } : e))
        : listing
    })
    expect(tampered).toEqual({
      ok: false,
      problems: [`the listing read for packages does not hash to ${packages}`],
    })
    const malformed = await readPinListings(root, ["README.md"], async (sha) => {
      const listing = await lsTree(sha)
      return [...listing, listing[0] as GitTreeEntry]
    })
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) expect(malformed.problems[0]).toMatch(/^the listing read for the root /)
  })

  it("orders directories root first and by depth", () => {
    expect(directoriesOf(["a/b/c.ts", "a/d.ts", "e.ts"])).toEqual(["", "a", "a/b"])
  })

  it("refuses a tree it could not encode faithfully", () => {
    const blob = { name: "a", mode: "100644", type: "blob" as const, sha: "0".repeat(40) }
    expect(() => treeId([blob, blob])).toThrow(/twice/)
    expect(() => treeId([{ ...blob, name: "a/b" }])).toThrow(/one path segment/)
    expect(() => treeId([{ ...blob, mode: "040000" }])).toThrow(/mode 040000 for a blob/)
  })
})
