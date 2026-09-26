import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { TargetSchema } from "../src/lib/targets/catalog.ts"
import { expectedPromotedOf, withExpectedPromoted } from "../src/lib/targets/init/dockerfile.ts"
import { initTarget, parseInitArgs, resolveTargetsDir } from "../src/lib/targets/init/init.ts"
import { formatManifest, renderDiff, writeProposal } from "../src/lib/targets/proposal.ts"
import { cleanupPinRepos, MINI, pinRepo } from "./pin-repo.ts"

const dirs: string[] = []
afterEach(() => {
  cleanupPinRepos()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const targetsDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-init-targets-"))
  dirs.push(dir)
  return dir
}

describe("initTarget", () => {
  it("proposes a new target as two added files, formatted as committed ones are, and writes nothing", () => {
    const { root, pin } = pinRepo(MINI)
    const targets = targetsDir()
    const result = initTarget({
      packageRef: "@m/app",
      pin,
      repositoryRoot: root,
      targetsDir: targets,
    })
    expect(result.id).toBe("app")
    expect(result.files.map((f) => [relative(targets, f.path), f.before])).toEqual([
      ["app/target.json", null],
      ["app/Dockerfile", null],
    ])
    expect(readdirSync(targets)).toEqual([])
    const [manifest, dockerfile] = result.files as [
      (typeof result.files)[0],
      (typeof result.files)[0],
    ]
    expect(TargetSchema.parse(JSON.parse(manifest.after)).commands.cwd).toBe("packages/app")
    expect(formatManifest(manifest.after)).toBe(manifest.after)
    expect(dockerfile.after).toContain('CAPTURED="app config core util"')
    const diff = renderDiff(result.files, targets)
    expect(diff).toContain("--- /dev/null\n+++ b/app/target.json\n")
    expect(diff).toContain("--- /dev/null\n+++ b/app/Dockerfile\n")
    expect(result.notes).toContain("resources are placeholders until target:measure proposes them")
  })

  it("is a fixed point: written, then generated again, it proposes nothing", () => {
    const { root, pin } = pinRepo(MINI)
    const targets = targetsDir()
    writeProposal(
      initTarget({ packageRef: "@m/app", pin, repositoryRoot: root, targetsDir: targets }).files,
    )
    const again = initTarget({
      packageRef: "packages/app",
      pin,
      repositoryRoot: root,
      targetsDir: targets,
    })
    expect(renderDiff(again.files, targets)).toBe("")
    expect(writeProposal(again.files)).toEqual([])
  })

  it("carries what a person or a measurement decided", () => {
    const { root, pin } = pinRepo(MINI)
    const targets = targetsDir()
    writeProposal(
      initTarget({ packageRef: "@m/app", pin, repositoryRoot: root, targetsDir: targets }).files,
    )
    const manifestPath = join(targets, "app", "target.json")
    const dockerfilePath = join(targets, "app", "Dockerfile")
    const current = JSON.parse(readFileSync(manifestPath, "utf8"))
    // Parsed, so the keys come out in the schema's order, as init writes them.
    const edited = TargetSchema.parse({
      ...current,
      resources: { memoryMb: 768, cpus: 2, commandTimeoutMs: 60_000, verifierDeadlineMs: 240_000 },
      draftingNotes: ["The app's tests build a fixture under os.tmpdir()."],
      commands: {
        ...current.commands,
        test: [...current.commands.test, "--exclude", "test/app.test.ts"],
      },
    })
    writeFileSync(manifestPath, formatManifest(`${JSON.stringify(edited, null, 2)}\n`))
    writeFileSync(
      dockerfilePath,
      withExpectedPromoted(readFileSync(dockerfilePath, "utf8"), ["zod"]),
    )
    const again = initTarget({
      packageRef: "@m/app",
      pin,
      repositoryRoot: root,
      targetsDir: targets,
    })
    expect(renderDiff(again.files, targets)).toBe("")
    expect(expectedPromotedOf(again.files[1]?.after ?? "")).toEqual(["zod"])
    expect(again.notes).toContain(
      `read from ${join(targets, "app")}: baseImage, resources, draftingNotes, 0 scoped file(s), 1 exclude(s), imageAssertResolves, capture.include and runnerConfig as supersets, EXPECTED_PROMOTED`,
    )
  })

  it("names only what the existing target holds: no empty draftingNotes or EXPECTED_PROMOTED", () => {
    const { root, pin } = pinRepo(MINI)
    const targets = targetsDir()
    writeProposal(
      initTarget({ packageRef: "@m/app", pin, repositoryRoot: root, targetsDir: targets }).files,
    )
    const again = initTarget({
      packageRef: "@m/app",
      pin,
      repositoryRoot: root,
      targetsDir: targets,
    })
    expect(again.notes).toContain(
      `read from ${join(targets, "app")}: baseImage, resources, 0 scoped file(s), 0 exclude(s), imageAssertResolves, capture.include and runnerConfig as supersets`,
    )
  })

  it("says so when only the Dockerfile's promotion set is carried", () => {
    const { root, pin } = pinRepo(MINI)
    const targets = targetsDir()
    const first = initTarget({
      packageRef: "@m/app",
      pin,
      repositoryRoot: root,
      targetsDir: targets,
    })
    mkdirSync(join(targets, "app"))
    writeFileSync(
      join(targets, "app", "Dockerfile"),
      withExpectedPromoted(first.files[1]?.after ?? "", ["zod"]),
    )
    const again = initTarget({
      packageRef: "@m/app",
      pin,
      repositoryRoot: root,
      targetsDir: targets,
    })
    expect(again.notes).toContain(
      `read from ${join(targets, "app", "Dockerfile")}: EXPECTED_PROMOTED (zod); there is no target.json to carry`,
    )
    expect(expectedPromotedOf(again.files[1]?.after ?? "")).toEqual(["zod"])
  })

  it("refuses an existing target.json that is not JSON or not a target, rather than replace it", () => {
    const { root, pin } = pinRepo(MINI)
    const targets = targetsDir()
    writeProposal(
      initTarget({ packageRef: "@m/app", pin, repositoryRoot: root, targetsDir: targets }).files,
    )
    const manifestPath = join(targets, "app", "target.json")
    const valid = readFileSync(manifestPath, "utf8")
    const init = () =>
      initTarget({ packageRef: "@m/app", pin, repositoryRoot: root, targetsDir: targets })
    writeFileSync(manifestPath, `${valid.slice(0, -3)}`)
    expect(init).toThrow(
      new RegExp(
        `^${join(targets, "app", "target.json")} does not parse \\(.*JSON.*\\): fix it or remove it to regenerate$`,
      ),
    )
    writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(valid), resources: "lots" }))
    expect(init).toThrow(
      new RegExp(
        `^${join(targets, "app", "target.json")} does not parse \\(resources: .+\\): fix it or remove it to regenerate$`,
      ),
    )
  })

  it("refuses a pin that is not a full commit sha", () => {
    const { root } = pinRepo(MINI)
    expect(() =>
      initTarget({
        packageRef: "@m/app",
        pin: "HEAD",
        repositoryRoot: root,
        targetsDir: targetsDir(),
      }),
    ).toThrow(/pin must be a full lowercase commit sha, got "HEAD"/)
  })

  it("refuses a target directory that belongs to another package, and an id that is not a name", () => {
    const { root, pin } = pinRepo(MINI)
    const targets = targetsDir()
    writeProposal(
      initTarget({ packageRef: "@m/app", pin, repositoryRoot: root, targetsDir: targets }).files,
    )
    expect(() =>
      initTarget({
        packageRef: "@m/util",
        id: "app",
        pin,
        repositoryRoot: root,
        targetsDir: targets,
      }),
    ).toThrow(`${join(targets, "app")} is the target of packages/app, not packages/util: pass --id`)
    expect(() =>
      initTarget({
        packageRef: "@m/util",
        id: "../x",
        pin,
        repositoryRoot: root,
        targetsDir: targets,
      }),
    ).toThrow(/is not a target id/)
  })
})

describe("target:init's arguments", () => {
  it("takes a package, and optionally a full pin, an id, a catalog, --with-dev-builds and --write", () => {
    expect(parseInitArgs(["@b4run/devkit"])).toEqual({
      packageRef: "@b4run/devkit",
      withDevBuilds: false,
      write: false,
    })
    expect(
      parseInitArgs([
        "packages/cli",
        "--pin",
        "a".repeat(40),
        "--id",
        "cli2",
        "--targets-dir",
        "/tmp/t",
        "--with-dev-builds",
        "--write",
      ]),
    ).toEqual({
      packageRef: "packages/cli",
      pin: "a".repeat(40),
      id: "cli2",
      targetsDir: "/tmp/t",
      withDevBuilds: true,
      write: true,
    })
    expect(() => parseInitArgs([])).toThrow(/usage: target-init.ts/)
    expect(() => parseInitArgs(["a", "b"])).toThrow(/usage: target-init.ts/)
    expect(() => parseInitArgs(["a", "--pin", "abc"])).toThrow(/full lowercase commit sha/)
    expect(() => parseInitArgs(["a", "--force"])).toThrow(/Unknown option '--force'/)
  })

  it("resolves a relative catalog against the directory pnpm was invoked from", () => {
    expect(resolveTargetsDir("/abs/t", { INIT_CWD: "/somewhere" }, "/cwd")).toBe("/abs/t")
    expect(resolveTargetsDir("scratch/t", { INIT_CWD: "/somewhere" }, "/cwd")).toBe(
      "/somewhere/scratch/t",
    )
    expect(resolveTargetsDir("scratch/t", {}, "/cwd")).toBe("/cwd/scratch/t")
  })
})

describe("proposals", () => {
  it("heads a modified file's diff a/ and b/", () => {
    const base = targetsDir()
    const diff = renderDiff([{ path: join(base, "x", "f"), before: "one\n", after: "two\n" }], base)
    expect(diff).toContain("--- a/x/f\n+++ b/x/f\n")
    expect(diff).toContain("-one\n+two\n")
  })

  it("writes each file whole, through a temporary file renamed into place", () => {
    const base = targetsDir()
    const path = join(base, "x", "f")
    expect(writeProposal([{ path, before: null, after: "one\n" }])).toEqual([path])
    expect(writeProposal([{ path, before: "one\n", after: "two\n" }])).toEqual([path])
    expect(readFileSync(path, "utf8")).toBe("two\n")
    expect(readdirSync(join(base, "x"))).toEqual(["f"])
  })

  it("refuses to write over a file that changed since the proposal was made, writing nothing", () => {
    const base = targetsDir()
    const a = join(base, "x", "a")
    const b = join(base, "x", "b")
    mkdirSync(join(base, "x"))
    writeFileSync(b, "edited\n")
    expect(() =>
      writeProposal([
        { path: a, before: null, after: "a\n" },
        { path: b, before: null, after: "b\n" },
      ]),
    ).toThrow(`${b} changed since the proposal was made: run target:init again`)
    expect(readdirSync(join(base, "x"))).toEqual(["b"])
    writeFileSync(a, "x\n")
    expect(() => writeProposal([{ path: a, before: "y\n", after: "a\n" }])).toThrow(
      `${a} changed since the proposal was made`,
    )
  })

  it("refuses a target directory that is a symbolic link", () => {
    const base = targetsDir()
    mkdirSync(join(base, "real"))
    symlinkSync(join(base, "real"), join(base, "x"))
    expect(() =>
      writeProposal([{ path: join(base, "x", "f"), before: null, after: "f\n" }]),
    ).toThrow(
      `${join(base, "x")} is a symbolic link: target:init writes only into a real directory`,
    )
    expect(readdirSync(join(base, "real"))).toEqual([])
  })

  it("names a missing controller Biome instead of a bare ENOENT", () => {
    expect(() => formatManifest("{}\n", targetsDir())).toThrow(
      "the controller's Biome is not installed: run pnpm install",
    )
  })
})
