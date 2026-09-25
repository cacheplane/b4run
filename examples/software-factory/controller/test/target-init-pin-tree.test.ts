import { writeFileSync } from "node:fs"
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
    expect(tree.read("packages/a")).toBeUndefined()
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

  it("refuses a pin the repository does not hold", () => {
    const { root } = pinRepo({ "a.txt": "a\n" })
    expect(() => gitPinTree(root, "f".repeat(40))).toThrow(/is not a commit in/)
  })
})
