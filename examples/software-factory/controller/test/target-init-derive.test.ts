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

  it("loads the vitest config vitest finds walking up from the package, in its order", () => {
    // Per directory, vitest.config.* before vite.config.*: both present, the first is loaded.
    const both = derive(
      {
        ...MINI,
        "packages/util/vitest.config.ts": "export default {}\n",
        "packages/util/vite.config.ts": "export default {}\n",
      },
      "@m/util",
    )
    expect(both.manifest.capture.include).toContain("packages/util/vitest.config.ts")
    expect(both.manifest.capture.include).not.toContain("packages/util/vite.config.ts")
    expect(both.manifest.runnerConfig).toContain("packages/util/vitest.config.ts")
    expect(both.manifest.runnerConfig).not.toContain("packages/util/vite.config.ts")
    // None in the package: the repository root's, which is captured and kept immutable.
    const rootConfig = {
      ...MINI,
      "vitest.config.ts": 'export default { test: { setupFiles: ["./vitest.setup.ts"] } }\n',
      "vitest.setup.ts": "export {}\n",
    }
    const { manifest, notes } = derive(rootConfig, "@m/util")
    expect(manifest.capture.include).toContain("vitest.config.ts")
    expect(manifest.runnerConfig).toContain("vitest.config.ts")
    expect(notes).toContain(
      "vitest.config.ts is the vitest config @m/util's tests load (none in packages/util; vitest looks up from there): captured and kept immutable",
    )
    expect(notes).toContain(
      "vitest.config.ts reads ./vitest.setup.ts (vitest.setup.ts), which the capture omits: a test that reaches it fails, and target:measure proposes excluding it",
    )
    // A package's own config wins over the root's.
    const app = derive(rootConfig)
    expect(app.manifest.capture.include).not.toContain("vitest.config.ts")
    expect(app.manifest.runnerConfig).not.toContain("vitest.config.ts")
    // One in a directory between the package and the root cannot be captured cleanly.
    expect(() =>
      derive({ ...MINI, "packages/vite.config.mjs": "export default {}\n" }, "@m/util"),
    ).toThrow(
      /packages\/vite\.config\.mjs is the vitest config @m\/util's tests load, outside the package and not at the repository root/,
    )
    expect(() =>
      derive({ ...MINI, "real.ts": "\n" }, "@m/util", {}, { "vitest.config.ts": "real.ts" }),
    ).toThrow(/vitest\.config\.ts at [0-9a-f]{40} is a link \(a symlink\), not a file/)
  })

  it("names the target package's top-level files the capture leaves out", () => {
    const { notes } = derive({
      ...MINI,
      "packages/app/vitest.setup.ts": "\n",
      "packages/app/.env.test": "A=1\n",
      "packages/core/README.md": "\n",
    })
    expect(notes).toContain("packages/app: files not captured: .env.test, vitest.setup.ts")
    expect(notes.some((note) => note.startsWith("packages/core: files not captured"))).toBe(false)
  })

  it("names every relative path the vitest config reads that the capture omits", () => {
    const { notes } = derive({
      ...MINI,
      "fixtures/data.json": "{}\n",
      "packages/app/vitest.config.ts": [
        'import shared from "./vitest.shared"',
        'const data = "../../fixtures/data.json"',
        'const tooling = "../tooling"',
        'const core = "../core/src"',
        'const own = "./src/index.ts"',
        "export default { shared, data, tooling, core, own }",
        "",
      ].join("\n"),
    })
    const reads = notes.filter((note) => note.startsWith("packages/app/vitest.config.ts reads"))
    expect(reads).toEqual([
      "packages/app/vitest.config.ts reads ../../fixtures/data.json (fixtures/data.json), which the capture omits: a test that reaches it fails, and target:measure proposes excluding it",
      "packages/app/vitest.config.ts reads ../tooling/ (packages/tooling), which the capture omits: a test that reaches it fails, and target:measure proposes excluding it",
      "packages/app/vitest.config.ts reads ./vitest.shared (packages/app/vitest.shared), which the capture omits: a test that reaches it fails, and target:measure proposes excluding it",
    ])
  })

  it("refuses a capture or runner entry a build output would hide", () => {
    const files = {
      ...MINI,
      "packages/core/lib/keep.ts": "\n",
      "packages/util/dist/keep.json": "{}\n",
    }
    expect(() =>
      derive(files, "@m/app", { captureInclude: ["packages/core/lib/keep.ts"] }),
    ).toThrow(
      /capture\.include entry packages\/core\/lib\/keep\.ts overlaps snapshotIgnore packages\/core\/lib\//,
    )
    expect(() =>
      derive(files, "@m/app", { runnerConfig: ["packages/util/dist/keep.json"] }),
    ).toThrow(
      /runnerConfig entry packages\/util\/dist\/keep\.json overlaps snapshotIgnore packages\/util\/dist\//,
    )
  })

  it("reads the TypeScript the package resolves, and refuses a version it cannot read", () => {
    const root = JSON.parse(MINI["package.json"] as string)
    const { typescript: _ts, ...devDependencies } = root.devDependencies
    const app = JSON.parse(MINI["packages/app/package.json"] as string)
    const withRoot = (extra: Record<string, unknown>) => ({
      ...MINI,
      "package.json": json({ ...root, devDependencies, ...extra }),
    })
    for (const spec of ["catalog:", "npm:typescript@7.0.2", "latest"])
      expect(() =>
        derive(withRoot({ devDependencies: { ...devDependencies, typescript: spec } })),
      ).toThrow(
        new RegExp(
          `typescript ${JSON.stringify(spec)}: target:init cannot tell its major version, which decides --builders`,
        ),
      )
    expect(() => derive(withRoot({}))).toThrow(/name no typescript/)
    // The root's dependencies count, not only its devDependencies.
    expect(
      derive(withRoot({ dependencies: { typescript: "^7.0.2" } })).manifest.commands.build,
    ).toContain("--builders")
    // The package's own TypeScript resolves before the root's.
    expect(
      derive({
        ...MINI,
        "packages/app/package.json": json({
          ...app,
          devDependencies: { ...app.devDependencies, typescript: "5.9.3" },
        }),
      }).manifest.commands.build,
    ).not.toContain("--builders")
  })

  it("names a carried test scope file the capture does not hold", () => {
    const { notes } = derive(MINI, "@m/app", {
      scope: ["test/app.test.ts"],
      captureInclude: ["packages/app/test/helpers/h.ts"],
    })
    expect(notes).toContain(
      "test/app.test.ts is in the test command, but the capture does not hold packages/app/test/app.test.ts: the suite cannot run it",
    )
    expect(
      derive(MINI, "@m/app", {
        scope: ["test/app.test.ts"],
        captureInclude: ["packages/app/test/app.test.ts"],
      }).notes.some((note) => note.includes("is in the test command")),
    ).toBe(false)
  })

  it("suggests --with-dev-builds only for a package the flag would capture", () => {
    const tooling = JSON.parse(MINI["packages/tooling/package.json"] as string)
    const { notes } = derive({
      ...MINI,
      "packages/tooling/package.json": json({
        ...tooling,
        devDependencies: { "@m/deep": "workspace:*" },
      }),
      // A build of its own (a package without one is a config package, captured whole).
      "packages/deep/package.json": json({
        name: "@m/deep",
        scripts: { build: "tsc -b tsconfig.json" },
      }),
      "packages/deep/tsconfig.json": json({ compilerOptions: { outDir: "dist" } }),
    })
    expect(notes).toContain(
      "@m/tooling (packages/tooling) is installed, not captured: a test importing it resolves the image's manifest-only copy and fails, and target:measure proposes excluding that test (or pass --with-dev-builds)",
    )
    expect(notes).toContain(
      "@m/deep (packages/deep) is installed, not captured: a test importing it resolves the image's manifest-only copy and fails, and target:measure proposes excluding that test",
    )
  })

  it("drops a carried capture entry the pin holds as a link, with a note", () => {
    const { manifest, notes } = derive(
      MINI,
      "@m/app",
      { captureInclude: ["packages/app/linked.json"] },
      { "packages/app/linked.json": "tsconfig.json" },
    )
    expect(manifest.capture.include).not.toContain("packages/app/linked.json")
    expect(notes).toContain(
      "dropped packages/app/linked.json from capture.include: at the pin it is a link (a symlink), which the capture refuses",
    )
  })

  it("keeps a carried root file, and a carried entry a captured directory covers only once", () => {
    const { manifest } = derive({ ...MINI, "tsconfig.base.json": "{}\n" }, "@m/app", {
      captureInclude: ["tsconfig.base.json", "packages/app/src/index.ts"],
    })
    expect(manifest.capture.include).toContain("tsconfig.base.json")
    expect(manifest.capture.include).toContain("packages/app/src")
    expect(manifest.capture.include).not.toContain("packages/app/src/index.ts")
  })
})
