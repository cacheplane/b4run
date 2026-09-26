import { afterEach, describe, expect, it } from "vitest"
import {
  type CarriedFields,
  DEFAULT_BASE_IMAGE,
  type DeriveOptions,
  deriveTarget,
  isPlaceholderResources,
  PLACEHOLDER_RESOURCES,
} from "../src/lib/targets/init/derive.ts"
import { gitPinTree } from "../src/lib/targets/init/pin-tree.ts"
import { readWorkspace, resolvePackage } from "../src/lib/targets/init/workspace-graph.ts"
import { cleanupPinRepos, json, MINI, pinRepo } from "./pin-repo.ts"

afterEach(cleanupPinRepos)

const derive = (
  files: Readonly<Record<string, string>>,
  ref = "@m/app",
  carried: CarriedFields = {},
  links: Readonly<Record<string, string>> = {},
  extra: Partial<DeriveOptions> = {},
) => {
  const { root, pin } = pinRepo(files, links)
  const tree = gitPinTree(root, pin)
  const graph = readWorkspace(tree)
  const pkg = resolvePackage(graph, ref)
  return {
    pin,
    ...deriveTarget(tree, graph, pkg, {
      id: pkg.dir.split("/").at(-1) as string,
      carried,
      ...extra,
    }),
  }
}

describe("deriveTarget", () => {
  it("derives the whole target of a package from its manifests at the pin", () => {
    const { pin, manifest, dockerfile, notes } = derive(MINI)
    expect(manifest).toEqual({
      id: "app",
      pin,
      root: ".",
      capture: {
        include: [
          "package.json",
          "pnpm-workspace.yaml",
          ".npmrc",
          "packages/app/package.json",
          "packages/app/src",
          "packages/app/test",
          "packages/app/tsconfig.build.json",
          "packages/app/tsconfig.json",
          "packages/app/vitest.config.ts",
          "packages/config",
          "packages/core/package.json",
          "packages/core/src",
          "packages/core/tsconfig.json",
          "packages/util/package.json",
          "packages/util/src",
          "packages/util/tsconfig.json",
        ],
      },
      snapshotIgnore: ["packages/app/dist/", "packages/core/lib/", "packages/util/dist/"],
      baseImage: DEFAULT_BASE_IMAGE,
      imageContext: [
        "package.json",
        "pnpm-workspace.yaml",
        "pnpm-lock.yaml",
        ".npmrc",
        "packages/app/package.json",
        "packages/config",
        "packages/core/package.json",
        "packages/tooling/package.json",
        "packages/util/package.json",
      ],
      lockfile: "pnpm-lock.yaml",
      imageAssertResolves: ["vitest", "typescript", "@types/node/package.json"],
      environmentLinks: [{ path: "node_modules", target: "/opt/targets/app/node_modules" }],
      commands: {
        cwd: "packages/app",
        build: [
          "pnpm",
          "exec",
          "tsc",
          "-b",
          "--builders",
          "1",
          "../util",
          "../core",
          "tsconfig.build.json",
        ],
        test: ["pnpm", "exec", "vitest", "--run", "--no-cache", "--config", "vitest.config.ts"],
        nodeTestExecArgv: [],
      },
      runnerConfig: [
        "package.json",
        "pnpm-workspace.yaml",
        ".npmrc",
        "packages/app/package.json",
        "packages/app/tsconfig.build.json",
        "packages/app/tsconfig.json",
        "packages/app/vitest.config.ts",
        "packages/config",
      ],
      resources: PLACEHOLDER_RESOURCES,
    })
    expect(dockerfile).toEqual({
      id: "app",
      filter: "@m/app",
      captured: [
        { dir: "app", name: "@m/app" },
        { dir: "config", name: "@m/config" },
        { dir: "core", name: "@m/core" },
        { dir: "util", name: "@m/util" },
      ],
      expectedPromoted: [],
      npmrc: true,
    })
    expect(notes).toEqual([
      "@m/tooling (packages/tooling) is installed, not captured: a test importing it resolves the image's manifest-only copy and fails, and target:measure proposes excluding that test (or pass --with-dev-builds)",
      "@m/app's build script does more than compile (tsc -b tsconfig.build.json && node scripts/docs.mjs): the target runs only its `tsc -b tsconfig.build.json`",
      expect.stringMatching(/^capture: 18 files, \d+ bytes$/),
      "packages/app: not captured: scripts/ (1 file)",
      "packages/util: not captured: test/ (1 file)",
      "resources are placeholders until target:measure proposes them",
      "no test is excluded: target:measure runs each file alone and proposes the excludes (none, if every file passes)",
    ])
  })

  it("derives a single-project target without a build order flag or a vitest config", () => {
    const { manifest } = derive(MINI, "@m/util")
    expect(manifest.commands.build).toEqual(["pnpm", "exec", "tsc", "-b", "tsconfig.json"])
    expect(manifest.commands.test).toEqual(["pnpm", "exec", "vitest", "--run", "--no-cache"])
    expect(manifest.capture.include).toEqual([
      "package.json",
      "pnpm-workspace.yaml",
      ".npmrc",
      "packages/config",
      "packages/util/package.json",
      "packages/util/src",
      "packages/util/test",
      "packages/util/tsconfig.json",
      "packages/util/tsconfig.test.json",
    ])
    expect(manifest.runnerConfig).toEqual([
      "package.json",
      "pnpm-workspace.yaml",
      ".npmrc",
      "packages/config",
      "packages/util/package.json",
      "packages/util/tsconfig.json",
      "packages/util/tsconfig.test.json",
    ])
  })

  it("omits --builders before TypeScript 7", () => {
    const root = JSON.parse(MINI["package.json"] as string)
    const { manifest } = derive({
      ...MINI,
      "package.json": json({
        ...root,
        devDependencies: { ...root.devDependencies, typescript: "5.9.3" },
      }),
    })
    expect(manifest.commands.build).toEqual([
      "pnpm",
      "exec",
      "tsc",
      "-b",
      "../util",
      "../core",
      "tsconfig.build.json",
    ])
  })

  it("builds and captures devDependencies with builds only when asked, the target still compiled last", () => {
    const { manifest, dockerfile, notes } = derive(MINI, "@m/app", {}, {}, { withDevBuilds: true })
    expect(manifest.commands.build).toEqual([
      "pnpm",
      "exec",
      "tsc",
      "-b",
      "--builders",
      "1",
      "../util",
      "../core",
      "../tooling",
      "tsconfig.build.json",
    ])
    expect(manifest.capture.include).toEqual(
      expect.arrayContaining([
        "packages/tooling/package.json",
        "packages/tooling/src",
        "packages/tooling/tsconfig.json",
      ]),
    )
    expect(dockerfile.captured.map((p) => p.dir)).toEqual([
      "app",
      "config",
      "core",
      "tooling",
      "util",
    ])
    expect(notes.some((note) => note.includes("is installed, not captured"))).toBe(false)
  })

  it("carries what a person or a measurement decided, as supersets, dropping what the pin no longer has", () => {
    const resources = {
      memoryMb: 768,
      cpus: 2,
      commandTimeoutMs: 60_000,
      verifierDeadlineMs: 240_000,
    }
    const baseImage = `node@sha256:${"e".repeat(64)}`
    const { manifest, dockerfile, notes } = derive(MINI, "@m/app", {
      baseImage,
      resources,
      draftingNotes: ["A route is a directory."],
      scope: ["test/app.test.ts"],
      excludes: ["test/helpers/h.ts", "test/gone.test.ts"],
      expectedPromoted: ["zod"],
      imageAssertResolves: ["commander", "vitest"],
      captureInclude: [
        "package.json",
        "packages/app/test/app.test.ts",
        "packages/app/scripts",
        "packages/tooling/src",
        "gone.txt",
      ],
      runnerConfig: ["packages/app/scripts/docs.mjs", "packages/app/gone.json"],
    })
    expect(manifest.baseImage).toBe(baseImage)
    expect(manifest.resources).toEqual(resources)
    expect(manifest.draftingNotes).toEqual(["A route is a directory."])
    expect(manifest.commands.test).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "--run",
      "--no-cache",
      "--config",
      "vitest.config.ts",
      "test/app.test.ts",
      "--exclude",
      "test/helpers/h.ts",
    ])
    expect(manifest.imageAssertResolves).toEqual([
      "vitest",
      "typescript",
      "@types/node/package.json",
      "commander",
    ])
    // A carried scope keeps the carried test capture instead of the whole directory.
    expect(manifest.capture.include).toContain("packages/app/test/app.test.ts")
    expect(manifest.capture.include).toContain("packages/app/scripts")
    expect(manifest.capture.include).not.toContain("packages/app/test")
    expect(manifest.capture.include).not.toContain("packages/tooling/src")
    expect(manifest.runnerConfig).toContain("packages/app/scripts/docs.mjs")
    expect(dockerfile.expectedPromoted).toEqual(["zod"])
    expect(notes).toEqual(
      expect.arrayContaining([
        "dropped test/gone.test.ts from the test command: no such file under packages/app at the pin",
        "dropped packages/tooling/src from capture.include: it belongs to no package this target captures",
        "dropped gone.txt from capture.include: not at the pin",
        "dropped packages/app/gone.json from runnerConfig: not at the pin",
      ]),
    )
    expect(notes.some((note) => note.startsWith("resources are placeholders"))).toBe(false)
    expect(isPlaceholderResources(PLACEHOLDER_RESOURCES)).toBe(true)
    expect(isPlaceholderResources(resources)).toBe(false)
  })

  it("names a sibling package the vitest config reads that the capture omits", () => {
    const { notes } = derive({
      ...MINI,
      "packages/app/vitest.config.ts":
        'export default { resolve: { alias: { x: "../tooling/src/index.ts", y: "../core/src" } } }\n',
    })
    expect(notes).toContain(
      "packages/app/vitest.config.ts reads ../tooling/ (packages/tooling), which the capture omits: a test that reaches it fails, and target:measure proposes excluding it",
    )
    expect(notes.some((note) => note.includes("reads ../core/"))).toBe(false)
  })

  it("refuses what it cannot generate, naming it", () => {
    const root = JSON.parse(MINI["package.json"] as string)
    expect(() =>
      derive({ ...MINI, "package.json": json({ ...root, packageManager: "npm@10.0.0" }) }),
    ).toThrow(/generates pnpm targets only/)
    const app = JSON.parse(MINI["packages/app/package.json"] as string)
    expect(() =>
      derive({
        ...MINI,
        "packages/app/package.json": json({
          ...app,
          dependencies: { ...app.dependencies, "@m/lint": "workspace:*" },
        }),
      }),
    ).toThrow(/@m\/lint lives at tools\/lint: target:init captures packages under packages\/ only/)
    expect(() => derive({ ...MINI, "packages/app/test/[id].test.ts": "\n" })).toThrow(
      /packages\/app\/test\/\[id\]\.test\.ts/,
    )
    expect(() => derive(MINI, "@m/app", {}, { "packages/app/src/link.ts": "index.ts" })).toThrow(
      /packages\/app\/src\/link\.ts/,
    )
    expect(() =>
      derive({
        ...MINI,
        "packages/core/tsconfig.json": json({
          extends: "../tooling/tsconfig.json",
          compilerOptions: { outDir: "lib" },
        }),
      }),
    ).toThrow(/extends packages\/tooling\/tsconfig.json, which no captured config package holds/)
    expect(() =>
      derive({
        ...MINI,
        "packages/app/package.json": json({
          ...app,
          scripts: { ...app.scripts, test: "vitest --run --config vitest.other.ts" },
        }),
      }),
    ).toThrow(/names --config vitest.other.ts, which does not exist/)
  })

  it("names the kind of a root file the pin holds as something other than a file", () => {
    const { "pnpm-lock.yaml": _lock, ".npmrc": _npmrc, ...rest } = MINI
    expect(() =>
      derive({ ...rest, ".npmrc": "\n" }, "@m/app", {}, { "pnpm-lock.yaml": ".npmrc" }),
    ).toThrow(/pnpm-lock\.yaml at [0-9a-f]{40} is a link \(a symlink\), not a file/)
    expect(() =>
      derive(
        { ...rest, "pnpm-lock.yaml": "\n", "npmrc.real": "\n" },
        "@m/app",
        {},
        { ".npmrc": "npmrc.real" },
      ),
    ).toThrow(/\.npmrc at [0-9a-f]{40} is a link \(a symlink\), not a file/)
    const { "pnpm-lock.yaml": _gone, ...noLock } = MINI
    expect(() => derive(noLock)).toThrow(/pnpm-lock\.yaml does not exist at [0-9a-f]{40}/)
  })

  it("names the external file a build extends further down its chain, not the file that extends it", () => {
    expect(() =>
      derive({
        ...MINI,
        "packages/config/base.json": json({
          extends: "../tooling/tsconfig.json",
          compilerOptions: { strict: true },
        }),
      }),
    ).toThrow(
      /@m\/util's build \(packages\/util\/tsconfig\.json\) extends packages\/tooling\/tsconfig\.json, which no captured config package holds/,
    )
  })

  it("refuses a project reference the build closure does not build with that config", () => {
    const core = JSON.parse(MINI["packages/core/tsconfig.json"] as string)
    // A reference to a built package's own build config (a directory means its tsconfig.json).
    expect(() =>
      derive({
        ...MINI,
        "packages/core/tsconfig.json": json({ ...core, references: [{ path: "../util" }] }),
      }),
    ).not.toThrow()
    expect(() =>
      derive({
        ...MINI,
        "packages/core/tsconfig.json": json({ ...core, references: [{ path: "../tooling" }] }),
      }),
    ).toThrow(
      /packages\/core\/tsconfig\.json references packages\/tooling\/tsconfig\.json, which is not the build config of a package this target builds/,
    )
    expect(() =>
      derive({
        ...MINI,
        "packages/core/tsconfig.json": json({
          ...core,
          references: [{ path: "../util/tsconfig.test.json" }],
        }),
      }),
    ).toThrow(/references packages\/util\/tsconfig\.test\.json, which is not the build config/)
  })

  it("refuses a src or test directory the pin holds as a link", () => {
    const { "packages/core/src/index.ts": _src, ...rest } = MINI
    expect(() =>
      derive(
        { ...rest, "packages/core/real/index.ts": "\n" },
        "@m/app",
        {},
        { "packages/core/src": "real" },
      ),
    ).toThrow(
      /packages\/core\/src at [0-9a-f]{40} is a link \(a symlink\): target:init captures directories/,
    )
  })

  it("refuses a vitest config the pin holds as a link, and drops a carried runnerConfig link with a note", () => {
    const { "packages/app/vitest.config.ts": _config, ...rest } = MINI
    expect(() =>
      derive(
        { ...rest, "packages/app/real.config.ts": "\n" },
        "@m/app",
        {},
        { "packages/app/vitest.config.ts": "real.config.ts" },
      ),
    ).toThrow(
      /names --config vitest\.config\.ts, which at [0-9a-f]{40} is a link \(a symlink\), not a file/,
    )
    const util = JSON.parse(MINI["packages/util/package.json"] as string)
    expect(() =>
      derive(
        {
          ...MINI,
          "packages/util/package.json": json({
            ...util,
            scripts: { ...util.scripts, test: "vitest" },
          }),
          "packages/util/x.ts": "\n",
        },
        "@m/util",
        {},
        { "packages/util/vite.config.mts": "x.ts" },
      ),
    ).toThrow(
      /packages\/util\/vite\.config\.mts at [0-9a-f]{40} is a link \(a symlink\), not a file: vitest would load it/,
    )
    const { manifest, notes } = derive(
      MINI,
      "@m/app",
      { runnerConfig: ["packages/app/linked.json"] },
      { "packages/app/linked.json": "tsconfig.json" },
    )
    expect(manifest.runnerConfig).not.toContain("packages/app/linked.json")
    expect(notes).toContain(
      "dropped packages/app/linked.json from runnerConfig: at the pin it is a link (a symlink), which the capture refuses",
    )
  })

  it("drops a carried exclude that is not a literal file path with a note instead of failing", () => {
    const { manifest, notes } = derive(
      { ...MINI, "packages/app/test/a b.test.ts": "\n" },
      "@m/app",
      { excludes: ["test/a b.test.ts", "test/helpers/h.ts"] },
      {},
    )
    expect(manifest.commands.test.slice(-2)).toEqual(["--exclude", "test/helpers/h.ts"])
    expect(notes).toContain(
      'dropped test/a b.test.ts from the test command: "test/a b.test.ts" is not a literal, package-relative path an exclude can name',
    )
  })
})
