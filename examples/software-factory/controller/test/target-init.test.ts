import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { TargetSchema } from "../src/lib/targets/catalog.ts"
import { expectedPromotedOf, withExpectedPromoted } from "../src/lib/targets/init/dockerfile.ts"
import { initTarget, parseInitArgs } from "../src/lib/targets/init/init.ts"
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
    expect(again.notes.some((note) => note.startsWith("carried from targets/app:"))).toBe(true)
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
    ).toThrow(/targets\/app is the target of packages\/app, not packages\/util: pass --id/)
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
  })
})
