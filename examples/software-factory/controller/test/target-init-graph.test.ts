import { afterEach, describe, expect, it } from "vitest"
import { gitPinTree } from "../src/lib/targets/init/pin-tree.ts"
import {
  closure,
  expandGlob,
  INSTALL,
  isConfigPackage,
  PROD,
  readWorkspace,
  resolvePackage,
  topologicalOrder,
  workspaceDependencies,
  workspaceGlobs,
} from "../src/lib/targets/init/workspace-graph.ts"
import { cleanupPinRepos, json, MINI, pinRepo } from "./pin-repo.ts"

afterEach(cleanupPinRepos)

const graphOf = (files: Readonly<Record<string, string>>) => {
  const { root, pin } = pinRepo(files)
  const tree = gitPinTree(root, pin)
  return { tree, graph: readWorkspace(tree) }
}
const dirs = (packages: readonly { readonly dir: string }[]) => packages.map((p) => p.dir)

describe("pnpm-workspace.yaml", () => {
  it("reads the block packages list, quoted or not, and stops at the next key", () => {
    expect(workspaceGlobs(MINI["pnpm-workspace.yaml"] as string)).toEqual(["packages/*", "tools/*"])
    expect(workspaceGlobs("packages:\n  - 'a/*' # the apps\n  -   b\nother: 1\n")).toEqual([
      "a/*",
      "b",
    ])
  })

  it("refuses what it does not read rather than guessing", () => {
    expect(() => workspaceGlobs("packages: [a, b]\n")).toThrow(/block `packages:` list/)
    expect(() => workspaceGlobs("packages:\n  - a: b\n")).toThrow(/unsupported line/)
    expect(() => workspaceGlobs("packages:\nother: 1\n")).toThrow(/lists no packages/)
  })

  it("expands whole-segment stars against the pin and refuses every other pattern", () => {
    const { tree } = graphOf(MINI)
    expect(expandGlob(tree, "packages/*")).toEqual([
      "packages/app",
      "packages/config",
      "packages/core",
      "packages/tooling",
      "packages/util",
    ])
    expect(expandGlob(tree, "tools/lint")).toEqual(["tools/lint"])
    expect(expandGlob(tree, "nowhere/*")).toEqual([])
    for (const glob of [
      "!packages/x",
      "packages/**",
      "packages/a*",
      "packages/{a,b}",
      "../x",
      "packages/+(app|core)",
      "packages/@(app)",
      "packages/(app)",
      "packages/app|core",
      "pack!ages/*",
      "packages/app+",
    ])
      expect(() => expandGlob(tree, glob), glob).toThrow(/literal segments and whole-segment \*/)
  })

  it("never lets * match a dot-directory, node_modules or bower_components", () => {
    const { tree } = graphOf({
      ...MINI,
      "packages/.hidden/package.json": json({ name: "@m/hidden" }),
      "packages/node_modules/package.json": json({ name: "@m/nm" }),
      "packages/bower_components/package.json": json({ name: "@m/bower" }),
    })
    // Each is at the pin: the glob, not the fixture, leaves them out.
    for (const dir of [".hidden", "node_modules", "bower_components"])
      expect(tree.kind(`packages/${dir}/package.json`), dir).toBe("file")
    expect(expandGlob(tree, "packages/*")).toEqual([
      "packages/app",
      "packages/config",
      "packages/core",
      "packages/tooling",
      "packages/util",
    ])
  })

  it("refuses a symlinked directory or a submodule a glob reaches, by name", () => {
    const linked = pinRepo(MINI, { "packages/alias": "util" })
    expect(() => expandGlob(gitPinTree(linked.root, linked.pin), "packages/*")).toThrow(
      /reaches packages\/alias, which at [0-9a-f]{40} is a link/,
    )
    const sub = pinRepo(MINI, {}, { "packages/vendored": "1".repeat(40) })
    const subTree = gitPinTree(sub.root, sub.pin)
    expect(() => expandGlob(subTree, "packages/*")).toThrow(
      /reaches packages\/vendored, which at [0-9a-f]{40} is a submodule/,
    )
    expect(() => expandGlob(subTree, "packages/vendored")).toThrow(/is a submodule/)
  })
})

describe("the workspace graph", () => {
  it("names every package by name and by directory", () => {
    const { graph } = graphOf(MINI)
    expect([...graph.packages.keys()].sort()).toEqual([
      "@m/app",
      "@m/config",
      "@m/core",
      "@m/lint",
      "@m/tooling",
      "@m/util",
    ])
    expect(resolvePackage(graph, "@m/app").dir).toBe("packages/app")
    expect(resolvePackage(graph, "packages/app/").name).toBe("@m/app")
    expect(resolvePackage(graph, "./packages/core").name).toBe("@m/core")
    expect(() => resolvePackage(graph, "@m/ghost")).toThrow(
      /no workspace package is named or lives at/,
    )
  })

  it("closes over dependencies for the build and over every kind for the install", () => {
    const { graph } = graphOf(MINI)
    const app = resolvePackage(graph, "@m/app")
    expect(dirs(closure(graph, app, PROD))).toEqual([
      "packages/app",
      "packages/core",
      "packages/util",
    ])
    expect(dirs(closure(graph, app, INSTALL))).toEqual([
      "packages/app",
      "packages/config",
      "packages/core",
      "packages/tooling",
      "packages/util",
    ])
    expect(isConfigPackage(resolvePackage(graph, "@m/config"))).toBe(true)
    expect(isConfigPackage(app)).toBe(false)
  })

  it("follows peerDependencies for the build and the install, as pnpm's graph does", () => {
    const { graph } = graphOf({
      ...MINI,
      "packages/app/package.json": json({
        name: "@m/app",
        scripts: { build: "tsc -b tsconfig.build.json", test: "vitest --run" },
        dependencies: { "@m/core": "workspace:*" },
        peerDependencies: { "@m/peer": "workspace:^", react: "^19" },
      }),
      "packages/peer/package.json": json({
        name: "@m/peer",
        scripts: { build: "tsc -b tsconfig.json" },
      }),
    })
    const app = resolvePackage(graph, "@m/app")
    expect(dirs(workspaceDependencies(graph, app, ["devDependencies"]))).toEqual([])
    expect(dirs(closure(graph, app, PROD))).toEqual([
      "packages/app",
      "packages/core",
      "packages/peer",
      "packages/util",
    ])
    expect(dirs(closure(graph, app, INSTALL))).toContain("packages/peer")
    expect(dirs(topologicalOrder(graph, closure(graph, app, PROD), PROD))).toEqual([
      "packages/peer",
      "packages/util",
      "packages/core",
      "packages/app",
    ])
  })

  it("refuses a workspace alias and a link: or file: spec naming a workspace directory", () => {
    const withDeps = (deps: Record<string, string>) =>
      graphOf({
        ...MINI,
        "packages/core/package.json": json({
          name: "@m/core",
          scripts: { build: "tsc -b tsconfig.json" },
          dependencies: deps,
        }),
      })
    const alias = withDeps({ utils: "workspace:@m/util@*" })
    expect(() => closure(alias.graph, resolvePackage(alias.graph, "@m/core"), PROD)).toThrow(
      /@m\/core \(packages\/core\) depends on utils as workspace:@m\/util@\*, a workspace alias: target:init reads workspace:<range> dependencies named by the package's own name only/,
    )
    for (const spec of ["link:../util", "file:../util/", "link:./../util"]) {
      const linked = withDeps({ "@m/util": spec })
      expect(
        () => closure(linked.graph, resolvePackage(linked.graph, "@m/core"), PROD),
        spec,
      ).toThrow(
        /depends on @m\/util as (link|file):.*, which names the workspace package @m\/util \(packages\/util\)/,
      )
    }
    // A link: outside the workspace is not a workspace edge.
    const outside = withDeps({ vendored: "link:../../vendor/x" })
    expect(dirs(closure(outside.graph, resolvePackage(outside.graph, "@m/core"), PROD))).toEqual([
      "packages/core",
    ])
  })

  it("orders a build closure dependencies first, ties by directory", () => {
    const { graph } = graphOf(MINI)
    const app = resolvePackage(graph, "@m/app")
    expect(dirs(topologicalOrder(graph, closure(graph, app, PROD), PROD))).toEqual([
      "packages/util",
      "packages/core",
      "packages/app",
    ])
    // Two packages with no edge between them come out in directory order.
    const both = [resolvePackage(graph, "@m/tooling"), resolvePackage(graph, "@m/config")]
    expect(dirs(topologicalOrder(graph, both, PROD))).toEqual([
      "packages/config",
      "packages/tooling",
    ])
  })

  it("refuses a workspace dependency no package is named, and a cycle", () => {
    const ghost = graphOf({
      ...MINI,
      "packages/core/package.json": json({
        name: "@m/core",
        scripts: { build: "tsc -b tsconfig.json" },
        dependencies: { "@m/ghost": "workspace:*" },
      }),
    })
    const core = resolvePackage(ghost.graph, "@m/core")
    expect(() => closure(ghost.graph, core, PROD)).toThrow(/depends on @m\/ghost as workspace:\*/)
    const cyclic = graphOf({
      ...MINI,
      "packages/util/package.json": json({
        name: "@m/util",
        scripts: { build: "tsc -b tsconfig.json" },
        dependencies: { "@m/core": "workspace:*" },
      }),
    })
    const app = resolvePackage(cyclic.graph, "@m/app")
    expect(() => topologicalOrder(cyclic.graph, closure(cyclic.graph, app, PROD), PROD)).toThrow(
      /dependency cycle: none of @m\/app, @m\/core, @m\/util can be built first/,
    )
  })

  it("refuses two packages of one name, and skips a matched directory with no name", () => {
    expect(() =>
      graphOf({ ...MINI, "tools/lint/package.json": json({ name: "@m/util" }) }),
    ).toThrow(/two workspace packages are named @m\/util: packages\/util and tools\/lint/)
    const { graph } = graphOf({ ...MINI, "tools/lint/package.json": json({ private: true }) })
    expect(graph.packages.has("@m/lint")).toBe(false)
  })
})
