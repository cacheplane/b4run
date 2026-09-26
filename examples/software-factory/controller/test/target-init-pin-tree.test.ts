import { execFileSync } from "node:child_process"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { gitPinTree } from "../src/lib/targets/init/pin-tree.ts"
import { cleanupPinRepos, pinRepo } from "./pin-repo.ts"

afterEach(cleanupPinRepos)

describe("a pin tree", () => {
  it("reads files, kinds, children and sized file lists at the pin", () => {
    const { root, pin } = pinRepo({
      "package.json": "{}\n",
      "packages/a/package.json": '{"name":"a"}\n',
      "packages/a/src/x.ts": "export {}\n",
      "has space/f.txt": "f\n",
    })
    const tree = gitPinTree(root, pin)
    expect(tree.pin).toBe(pin)
    expect(tree.read("package.json")).toBe("{}\n")
    expect(() => tree.read("packages/a")).toThrow(/packages\/a at .* is a dir, not a file/)
    expect(tree.read("nope.json")).toBeUndefined()
    expect(tree.kind("packages/a")).toBe("dir")
    expect(tree.kind("packages/a/package.json")).toBe("file")
    expect(tree.kind("nope")).toBeUndefined()
    expect(tree.children("")).toEqual([
      { name: "has space", kind: "dir" },
      { name: "package.json", kind: "file" },
      { name: "packages", kind: "dir" },
    ])
    expect(tree.children("packages")).toEqual([{ name: "a", kind: "dir" }])
    expect(tree.files("packages/a")).toEqual([
      { path: "packages/a/package.json", bytes: 13, mode: "100644" },
      { path: "packages/a/src/x.ts", bytes: 10, mode: "100644" },
    ])
    expect(tree.files("has space")).toEqual([{ path: "has space/f.txt", bytes: 2, mode: "100644" }])
  })

  it("never reads the working tree", () => {
    const { root, pin } = pinRepo({ "package.json": "{}\n" })
    writeFileSync(join(root, "package.json"), '{"edited":true}\n')
    writeFileSync(join(root, "untracked.json"), "{}\n")
    const tree = gitPinTree(root, pin)
    expect(tree.read("package.json")).toBe("{}\n")
    expect(tree.kind("untracked.json")).toBeUndefined()
  })

  it("names a symlink a link", () => {
    const { root, pin } = pinRepo({ "src/a.ts": "export {}\n" }, { "src/b.ts": "a.ts" })
    const tree = gitPinTree(root, pin)
    expect(tree.children("src")).toEqual([
      { name: "a.ts", kind: "file" },
      { name: "b.ts", kind: "link" },
    ])
    expect(tree.files("src").map((f) => f.mode)).toEqual(["100644", "120000"])
  })

  it("names a symlink a link and a submodule a submodule, and reads neither as a file", () => {
    const { root, pin } = pinRepo(
      { "src/a.ts": "export {}\n" },
      { "src/b.ts": "a.ts", linked: "src" },
      { "vendor/sub": "1".repeat(40) },
    )
    const tree = gitPinTree(root, pin)
    expect(tree.kind("src/b.ts")).toBe("link")
    expect(tree.kind("linked")).toBe("link")
    expect(tree.kind("vendor/sub")).toBe("submodule")
    expect(tree.children("vendor")).toEqual([{ name: "sub", kind: "submodule" }])
    expect(() => tree.read("src/b.ts")).toThrow(/src\/b\.ts at .* is a link, not a file/)
    expect(() => tree.read("vendor/sub")).toThrow(/vendor\/sub at .* is a submodule, not a file/)
    expect(tree.children("linked")).toEqual([])
    expect(tree.files("vendor")).toEqual([{ path: "vendor/sub", bytes: 0, mode: "160000" }])
  })

  it("reads an executable as a file", () => {
    const { root } = pinRepo({ "run.sh": "#!/bin/sh\n" })
    execFileSync("git", ["-C", root, "update-index", "--chmod=+x", "run.sh"])
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "x"])
    const pin = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    const tree = gitPinTree(root, pin)
    expect(tree.kind("run.sh")).toBe("file")
    expect(tree.read("run.sh")).toBe("#!/bin/sh\n")
    expect(tree.files("run.sh")).toEqual([{ path: "run.sh", bytes: 10, mode: "100755" }])
  })

  it("surfaces a git failure instead of calling the path absent", () => {
    const { root, pin } = pinRepo({ "packages/a/package.json": "{}\n", "b.txt": "b\n" })
    const object = (spec: string) =>
      execFileSync("git", ["-C", root, "rev-parse", spec], { encoding: "utf8" }).trim()
    const loose = (oid: string) => join(root, ".git", "objects", oid.slice(0, 2), oid.slice(2))
    // A blob the listing names but the object store lost: the read fails loudly.
    rmSync(loose(object(`${pin}:b.txt`)))
    const tree = gitPinTree(root, pin)
    expect(tree.kind("b.txt")).toBe("file")
    expect(() => tree.read("b.txt")).toThrow(/b\.txt/)
    // A tree the object store lost: the pin cannot be listed at all.
    rmSync(loose(object(`${pin}:packages`)))
    expect(() => gitPinTree(root, pin)).toThrow(/cannot list .* at [0-9a-f]{40}:/)
  })

  it("names paths from the repository's top level whatever directory it is given", () => {
    const { root, pin } = pinRepo({
      "package.json": "{}\n",
      "packages/a/package.json": '{"name":"a"}\n',
    })
    const tree = gitPinTree(join(root, "packages"), pin)
    expect(tree.kind("package.json")).toBe("file")
    expect(tree.read("package.json")).toBe("{}\n")
    expect(tree.kind("a")).toBeUndefined()
    expect(tree.children("").map((e) => e.name)).toEqual(["package.json", "packages"])
    expect(tree.files("packages").map((f) => f.path)).toEqual(["packages/a/package.json"])
  })

  it("resolves the pin once to the full commit sha", () => {
    const { root, pin } = pinRepo({ "a.txt": "a\n" })
    expect(gitPinTree(root, pin.slice(0, 12)).pin).toBe(pin)
    expect(gitPinTree(root, "HEAD").pin).toBe(pin)
  })

  it("lists every file for the root, and never a sibling whose name a directory prefixes", () => {
    const { root, pin } = pinRepo({
      "a.txt": "a\n",
      "packages/a/x.ts": "x\n",
      "packages/ab/y.ts": "y\n",
      "packages/a.ts": "z\n",
    })
    const tree = gitPinTree(root, pin)
    const paths = (path: string) => tree.files(path).map((f) => f.path)
    expect(paths("")).toEqual(["a.txt", "packages/a.ts", "packages/a/x.ts", "packages/ab/y.ts"])
    expect(paths("packages/a")).toEqual(["packages/a/x.ts"])
    expect(paths("packages/a/")).toEqual(["packages/a/x.ts"])
    expect(paths("packages/a.ts")).toEqual(["packages/a.ts"])
    expect(paths("nope")).toEqual([])
  })

  it("refuses a pin the repository does not hold", () => {
    const { root } = pinRepo({ "a.txt": "a\n" })
    expect(() => gitPinTree(root, "f".repeat(40))).toThrow(/is not a commit in .*: fatal: /)
    expect(() => gitPinTree(root, "--all")).toThrow(/is not a commit in/)
  })
})
