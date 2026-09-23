import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { appRoot, repositoryRoot, TargetSchema, targetsDir } from "../src/lib/targets/catalog.ts"
import {
  firstMissingPath,
  parsePrepareArgs,
  pathExistsAtPin,
  pathsRequiredAtPin,
  withImageAt,
} from "../src/lib/targets/prepare.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const PIN_A = "a".repeat(40)
const PIN_B = "b".repeat(40)
const image = (n: string) => ({
  localId: `sha256:${n.repeat(64)}`,
  platform: "linux/arm64",
  baseManifestDigest: `sha256:${"b".repeat(64)}`,
  dockerfileSha256: "c".repeat(64),
  lockfileSha256: "d".repeat(64),
  pnpmVersion: "10.33.0",
})
const manifest = TargetSchema.parse({
  id: "t",
  pin: PIN_A,
  root: "pkg",
  capture: { include: ["src"] },
  snapshotIgnore: [],
  images: { [PIN_A]: image("1") },
  imageContext: ["pkg/package.json", "pkg/package-lock.json"],
  lockfile: "pkg/package-lock.json",
  imageAssertResolves: [],
  environmentLinks: [{ path: "node_modules", target: "/opt/targets/t/node_modules" }],
  commands: { cwd: ".", build: [], test: ["npm", "test"], nodeTestExecArgv: [] },
  runnerConfig: ["package.json"],
  resources: { memoryMb: 1, cpus: 1, commandTimeoutMs: 1, verifierDeadlineMs: 1 },
})

describe("parsePrepareArgs", () => {
  it("takes a target id and an optional full-sha --pin", () => {
    expect(parsePrepareArgs(["devkit"])).toEqual({ id: "devkit" })
    expect(parsePrepareArgs(["devkit", "--pin", PIN_B])).toEqual({ id: "devkit", pin: PIN_B })
    expect(parsePrepareArgs(["--pin", PIN_B, "devkit"])).toEqual({ id: "devkit", pin: PIN_B })
  })

  it("refuses no id, two ids, an unknown flag, and a pin that is not a full sha", () => {
    expect(() => parsePrepareArgs([])).toThrow(/usage/)
    expect(() => parsePrepareArgs(["a", "b"])).toThrow(/usage/)
    expect(() => parsePrepareArgs(["a", "--force"])).toThrow()
    expect(() => parsePrepareArgs(["a", "--pin", "abc123"])).toThrow(/full lowercase commit sha/)
  })
})

describe("the paths required at the pin", () => {
  it("names the root, every build-context entry and the lockfile, once each", () => {
    expect(pathsRequiredAtPin(manifest)).toEqual([
      "pkg",
      "pkg/package.json",
      "pkg/package-lock.json",
    ])
    expect(pathsRequiredAtPin({ ...manifest, root: "." })).toEqual([
      "pkg/package.json",
      "pkg/package-lock.json",
    ])
  })

  it("reports the first one missing", () => {
    const present = new Set(["pkg", "pkg/package.json"])
    expect(firstMissingPath(pathsRequiredAtPin(manifest), (p) => present.has(p))).toBe(
      "pkg/package-lock.json",
    )
    expect(firstMissingPath(["x"], () => true)).toBeUndefined()
  })

  it("asks git whether a file or directory exists at a commit", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-prepare-repo-"))
    dirs.push(root)
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
    git("init", "-q")
    git("config", "user.email", "t@example.com")
    git("config", "user.name", "t")
    mkdirSync(join(root, "old"))
    writeFileSync(join(root, "old", "a.txt"), "a\n")
    git("add", ".")
    git("commit", "-q", "-m", "one")
    const first = git("rev-parse", "HEAD")
    git("mv", "old", "new")
    git("commit", "-q", "-m", "moved")
    const second = git("rev-parse", "HEAD")
    expect(pathExistsAtPin(root, first, "old")).toBe(true)
    expect(pathExistsAtPin(root, first, "old/a.txt")).toBe(true)
    expect(pathExistsAtPin(root, second, "old/a.txt")).toBe(false)
    expect(pathExistsAtPin(root, second, "new/a.txt")).toBe(true)
  })
})

describe("withImageAt", () => {
  it("records the image at the pin, keeps every other pin's entry, and writes images last", () => {
    const next = withImageAt(manifest, PIN_B, image("2"))
    expect(next.images).toEqual({ [PIN_A]: image("1"), [PIN_B]: image("2") })
    expect(Object.keys(next).at(-1)).toBe("images")
    expect(withImageAt(manifest, PIN_A, image("3")).images).toEqual({ [PIN_A]: image("3") })
    expect(TargetSchema.parse(next)).toEqual(next)
  })
})

describe("prepare-target.ts at a pin its paths do not exist at", () => {
  it("refuses cli-flags at HEAD by the path that moved, before any build", () => {
    const manifestPath = join(targetsDir, "cli-flags", "target.json")
    const before = readFileSync(manifestPath, "utf8")
    const head = execFileSync("git", ["-C", repositoryRoot(), "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim()
    // The script is run as the operator runs it; it fails on the path check, which comes
    // before the base pull and the build, so no Docker is needed to reach it.
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/prepare-target.ts", "cli-flags", "--pin", head],
      { cwd: appRoot, encoding: "utf8", timeout: 60_000 },
    )
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain(
      `Target "cli-flags" names examples/software-factory/server/fixtures/cli-flags/project, which does not exist at ${head}: it cannot be prepared at that pin`,
    )
    expect(readFileSync(manifestPath, "utf8")).toBe(before)
  })
})
