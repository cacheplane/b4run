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

  it("refuses a compile that names more than one config, or passes anything after it", () => {
    for (const script of [
      "tsc -b a.json b.json",
      "tsc -b tsconfig.json --clean",
      "tsc --build tsconfig.json --watch",
      "tsc -b tsconfig.json --verbose && node scripts/docs.mjs",
      "tsc -b tsconfig.json; node scripts/docs.mjs",
    ])
      expect(() => buildScriptTsconfig(withBuild(script)), script).toThrow(
        /must name exactly one tsconfig and nothing after it/,
      )
  })

  it("refuses a second compile that is not tsc -b, since the target would not run it", () => {
    expect(() =>
      buildScriptTsconfig(withBuild("tsc -b tsconfig.json && tsc -p tsconfig.cjs.json")),
    ).toThrow(/runs `tsc -p tsconfig.cjs.json`, which is not a `tsc -b <tsconfig>`/)
  })

  it("refuses a build that changes directory anywhere in its chain", () => {
    for (const script of [
      "cd src && tsc -b tsconfig.json",
      "tsc -b tsconfig.json && cd dist && node x.mjs",
      "node a.mjs; cd .. && tsc -b tsconfig.json",
    ])
      expect(() => buildScriptTsconfig(withBuild(script)), script).toThrow(/changes directory/)
  })

  it("refuses a config path that leaves the package, and a quote it cannot match", () => {
    expect(() => buildScriptTsconfig(withBuild("tsc -b ../core/tsconfig.json"))).toThrow(
      /a package-relative tsconfig/,
    )
    expect(() => buildScriptTsconfig(withBuild(`node -e "x && tsc -b tsconfig.json`))).toThrow(
      /unbalanced quote/,
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
      references: [],
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

/** MINI with `@m/core`'s tsconfig (and any other files) replaced. */
const core = (tsconfig: unknown, extra: Readonly<Record<string, string>> = {}) => {
  const { tree, pkg } = at({ ...MINI, "packages/core/tsconfig.json": json(tsconfig), ...extra })
  return () => buildConfig(tree, pkg("@m/core"))
}

describe("where a build writes, by TypeScript's own rules", () => {
  it("resolves each path option against the file that sets it, the nearest one winning", () => {
    // An in-package parent in a subdirectory: its "../lib" is relative to configs/.
    const nested = core(
      { extends: "./configs/base.json" },
      {
        "packages/core/configs/base.json": json({
          extends: "../../config/base.json",
          compilerOptions: { outDir: "../lib" },
        }),
      },
    )()
    expect(nested.outDir).toBe("packages/core/lib/")
    expect(nested.files).toEqual(["packages/core/tsconfig.json", "packages/core/configs/base.json"])
    expect(nested.externalExtends).toEqual(["packages/config/base.json"])
    // A child's outDir overrides its parent's.
    expect(
      core(
        { extends: "./parent.json", compilerOptions: { outDir: "out" } },
        { "packages/core/parent.json": json({ compilerOptions: { outDir: "lib" } }) },
      )().outDir,
    ).toBe("packages/core/out/")
    // An outDir set in the config package resolves there, outside this package.
    expect(
      core(
        { extends: "../config/base.json" },
        { "packages/config/base.json": json({ compilerOptions: { outDir: "dist" } }) },
      ),
    ).toThrow(/writes packages\/config\/dist, outside the package/)
  })

  it("keeps reading through a config package, recording every file it extends", () => {
    const build = core(
      { extends: "../config/node.json", compilerOptions: { outDir: "lib" } },
      {
        "packages/config/node.json": json({ extends: "./library", compilerOptions: {} }),
        "packages/config/library.json": json({ extends: "./base.json" }),
      },
    )()
    // "./library" resolves as TypeScript does: the path, else the path plus ".json".
    expect(build.externalExtends).toEqual([
      "packages/config/node.json",
      "packages/config/library.json",
      "packages/config/base.json",
    ])
    expect(build.files).toEqual(["packages/core/tsconfig.json"])
  })

  it("places tsc -b's default build info as getTsBuildInfoEmitOutputFilePath does", () => {
    // TypeScript's getTsBuildInfoEmitOutputFilePath (lib/typescript.js in 5.x/6.x; TS 7.0.2 was
    // run to confirm): with no tsBuildInfoFile, the build info is <outDir>/<config path relative
    // to rootDir>.tsbuildinfo, or <outDir>/<config basename>.tsbuildinfo with no rootDir. With
    // rootDir "src" that is packages/core/tsconfig.tsbuildinfo, outside the outDir.
    expect(core({ compilerOptions: { outDir: "dist", rootDir: "src" } })).toThrow(
      /writes packages\/core\/tsconfig.tsbuildinfo, outside its outDir packages\/core\/dist/,
    )
    // A rootDir from the config package counts, resolved against that package:
    // packages/core/lib + (../core/tsconfig relative to packages/config).
    expect(
      core(
        { extends: "../config/base.json", compilerOptions: { outDir: "lib" } },
        { "packages/config/base.json": json({ compilerOptions: { rootDir: "." } }) },
      ),
    ).toThrow(/writes packages\/core\/core\/tsconfig.tsbuildinfo, outside its outDir/)
    expect(core({ compilerOptions: { outDir: "dist", rootDir: "." } })().outDir).toBe(
      "packages/core/dist/",
    )
    expect(core({ compilerOptions: { outDir: "dist" } })().outDir).toBe("packages/core/dist/")
    // The shipped packages' shape: rootDir src, the build info named inside the outDir.
    expect(
      core({
        compilerOptions: {
          outDir: "dist",
          rootDir: "src",
          tsBuildInfoFile: "dist/tsconfig.tsbuildinfo",
        },
      })().outDir,
    ).toBe("packages/core/dist/")
  })

  it("refuses declarations or a bundle written outside the outDir", () => {
    expect(core({ compilerOptions: { outDir: "lib", declarationDir: "types" } })).toThrow(
      /writes packages\/core\/types, outside its outDir/,
    )
    expect(core({ compilerOptions: { outDir: "lib", declarationDir: "lib/types" } })().outDir).toBe(
      "packages/core/lib/",
    )
    expect(core({ compilerOptions: { outDir: "lib", outFile: "bundle.js" } })).toThrow(
      /writes packages\/core\/bundle.js, outside its outDir/,
    )
  })

  it("refuses an outDir that overlaps the source or test directory the target captures", () => {
    for (const outDir of ["src", "test", ".", "src/generated"])
      expect(core({ compilerOptions: { outDir } }), outDir).toThrow(
        /overlaps packages\/core\/(src|test)/,
      )
  })

  it("refuses what it cannot read literally", () => {
    expect(core({ compilerOptions: { outDir: 5 } })).toThrow(/outDir is 5, not a path/)
    // TypeScript's own ${configDir} substitution, written as a tsconfig spells it.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal tsconfig text
    expect(core({ compilerOptions: { outDir: "${configDir}/lib" } })).toThrow(
      /\$\{configDir\}\/lib.*substitution/,
    )
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal tsconfig text
    expect(core({ extends: "${configDir}/../config/base.json" })).toThrow(/substitution/)
  })

  it("refuses an extends cycle, and a chain deeper than it follows", () => {
    expect(
      core(
        { extends: "./a.json", compilerOptions: { outDir: "lib" } },
        { "packages/core/a.json": json({ extends: "./tsconfig.json" }) },
      ),
    ).toThrow(/extends cycle/)
    const chain: Record<string, string> = {}
    for (let i = 0; i < 9; i++)
      chain[`packages/core/c${i}.json`] = json({ extends: `./c${i + 1}.json` })
    chain["packages/core/c9.json"] = json({ compilerOptions: { outDir: "lib" } })
    expect(core({ extends: "./c0.json" }, chain)).toThrow(/more than 8 deep/)
  })

  it("returns the build config's own project references, resolved to the repository", () => {
    expect(
      core({
        extends: "../config/base.json",
        compilerOptions: { outDir: "lib" },
        references: [{ path: "../util" }, { path: "../tooling/tsconfig.json" }],
      })().references,
    ).toEqual(["packages/util", "packages/tooling/tsconfig.json"])
    expect(core({ compilerOptions: { outDir: "lib" }, references: [{ path: 1 }] })).toThrow(
      /references/,
    )
  })
})
