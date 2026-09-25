import { afterEach, describe, expect, it } from "vitest"
import { gitPinTree } from "../src/lib/targets/init/pin-tree.ts"
import {
  buildConfig,
  buildScriptTsconfig,
  packageTsconfigs,
} from "../src/lib/targets/init/tsconfig.ts"
import { readWorkspace, resolvePackage } from "../src/lib/targets/init/workspace-graph.ts"
import { cleanupPinRepos, json, MINI, pinRepo } from "./pin-repo.ts"

afterEach(cleanupPinRepos)

const at = (files: Readonly<Record<string, string>>) => {
  const { root, pin } = pinRepo(files)
  const tree = gitPinTree(root, pin)
  const graph = readWorkspace(tree)
  return { tree, pkg: (ref: string) => resolvePackage(graph, ref) }
}
const withBuild = (build: string | undefined) => ({
  name: "@m/x",
  dir: "packages/x",
  manifest: { name: "@m/x", ...(build === undefined ? {} : { scripts: { build } }) },
})

describe("the tsconfig a build script compiles", () => {
  it("is the one file its `tsc -b` names, whatever runs around it", () => {
    expect(buildScriptTsconfig(withBuild("tsc -b tsconfig.json"))).toBe("tsconfig.json")
    expect(
      buildScriptTsconfig(withBuild("tsc -b tsconfig.build.json && node scripts/docs.mjs")),
    ).toBe("tsconfig.build.json")
    // ag-ui's shape: a quoted node -e holding its own && before and after the compile.
    expect(
      buildScriptTsconfig(
        withBuild(`node -e "if (a && b) rm()" && tsc --build tsconfig.json && node -e "copy()"`),
      ),
    ).toBe("tsconfig.json")
    expect(buildScriptTsconfig(withBuild(undefined))).toBeUndefined()
  })

  it("refuses a build it cannot read as exactly one tsc -b", () => {
    expect(() => buildScriptTsconfig(withBuild("tsup src/index.ts"))).toThrow(/found 0/)
    expect(() => buildScriptTsconfig(withBuild("tsc -b a.json && tsc -b b.json"))).toThrow(
      /found 2/,
    )
  })
})

describe("a package's build configuration at the pin", () => {
  it("follows extends inside the package, stops at a config package, and finds the outDir", () => {
    const { tree, pkg } = at(MINI)
    expect(buildConfig(tree, pkg("@m/app"))).toEqual({
      tsconfig: "tsconfig.build.json",
      files: ["packages/app/tsconfig.build.json", "packages/app/tsconfig.json"],
      outDir: "packages/app/dist/",
      externalExtends: ["packages/config/base.json"],
    })
    expect(buildConfig(tree, pkg("@m/core")).outDir).toBe("packages/core/lib/")
    expect(buildConfig(tree, pkg("@m/tooling")).externalExtends).toEqual([])
  })

  it("lists every tsconfig*.json in the package directory", () => {
    const { tree, pkg } = at(MINI)
    expect(packageTsconfigs(tree, pkg("@m/app"))).toEqual([
      "packages/app/tsconfig.build.json",
      "packages/app/tsconfig.json",
    ])
    expect(packageTsconfigs(tree, pkg("@m/util"))).toEqual([
      "packages/util/tsconfig.json",
      "packages/util/tsconfig.test.json",
    ])
  })

  it("refuses a build that says nothing about where it writes, or writes outside the package", () => {
    const none = at({
      ...MINI,
      "packages/core/tsconfig.json": json({ extends: "../config/base.json" }),
    })
    expect(() => buildConfig(none.tree, none.pkg("@m/core"))).toThrow(
      /sets no compilerOptions.outDir/,
    )
    const outside = at({
      ...MINI,
      "packages/core/tsconfig.json": json({ compilerOptions: { outDir: "../../out" } }),
    })
    expect(() => buildConfig(outside.tree, outside.pkg("@m/core"))).toThrow(/outside the package/)
    const info = at({
      ...MINI,
      "packages/core/tsconfig.json": json({
        compilerOptions: { outDir: "lib", tsBuildInfoFile: "build.tsbuildinfo" },
      }),
    })
    expect(() => buildConfig(info.tree, info.pkg("@m/core"))).toThrow(
      /writes packages\/core\/build.tsbuildinfo, outside its outDir packages\/core\/lib/,
    )
    const jsonc = at({ ...MINI, "packages/core/tsconfig.json": "{ // a comment\n}\n" })
    expect(() => buildConfig(jsonc.tree, jsonc.pkg("@m/core"))).toThrow(/is not plain JSON/)
    const bare = at({
      ...MINI,
      "packages/core/tsconfig.json": json({
        extends: "@tsconfig/node24",
        compilerOptions: { outDir: "lib" },
      }),
    })
    expect(() => buildConfig(bare.tree, bare.pkg("@m/core"))).toThrow(
      /follows only relative extends/,
    )
  })
})
