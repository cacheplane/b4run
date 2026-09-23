import { execFileSync, spawn } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { appRoot, repositoryRoot, TargetSchema, targetsDir } from "../src/lib/targets/catalog.ts"
import {
  capturedListMismatch,
  capturedPackages,
  dockerfileCapturedPackages,
  firstMissingPath,
  parsePrepareArgs,
  pathExistsAtPin,
  pathsRequiredAtPin,
  recordImage,
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
  it("names the root, the build context, the lockfile, the capture, the cwd and the runner configuration, once each", () => {
    expect(pathsRequiredAtPin(manifest)).toEqual([
      "pkg",
      "pkg/package.json",
      "pkg/package-lock.json",
      "pkg/src",
    ])
    expect(
      pathsRequiredAtPin({
        ...manifest,
        commands: { ...manifest.commands, cwd: "packages/x" },
        runnerConfig: ["vitest.config.ts"],
      }),
    ).toEqual([
      "pkg",
      "pkg/package.json",
      "pkg/package-lock.json",
      "pkg/src",
      "pkg/packages/x",
      "pkg/vitest.config.ts",
    ])
    expect(pathsRequiredAtPin({ ...manifest, root: "." })).toEqual([
      "pkg/package.json",
      "pkg/package-lock.json",
      "src",
      "package.json",
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

describe("recordImage", () => {
  const identity = (json: string) => json

  it("re-reads the manifest, keeps an entry recorded during the build, and renames into place", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-record-"))
    dirs.push(dir)
    const path = join(dir, "target.json")
    writeFileSync(path, JSON.stringify(manifest))
    // Another prepare records PIN_B while this one builds (it read the manifest before).
    const concurrent = withImageAt(manifest, PIN_B, image("2"))
    writeFileSync(path, JSON.stringify(concurrent))
    const pinC = "c".repeat(40)
    await recordImage(path, pinC, image("3"), identity)
    const after = TargetSchema.parse(JSON.parse(readFileSync(path, "utf8")))
    expect(after.images).toEqual({ [PIN_A]: image("1"), [PIN_B]: image("2"), [pinC]: image("3") })
    // Nothing left beside it: the bytes went through a temporary sibling and a rename.
    expect(readdirSync(dir)).toEqual(["target.json"])
  })

  it("writes what the formatter returns, and leaves the manifest untouched when formatting fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-record-"))
    dirs.push(dir)
    const path = join(dir, "target.json")
    const before = JSON.stringify(manifest)
    writeFileSync(path, before)
    await expect(
      recordImage(path, PIN_B, image("2"), () => {
        throw new Error("formatter down")
      }),
    ).rejects.toThrow(/formatter down/)
    expect(readFileSync(path, "utf8")).toBe(before)
    await recordImage(path, PIN_B, image("2"), (json) => `${json.trimEnd()}\n`)
    expect(readFileSync(path, "utf8").endsWith("}\n")).toBe(true)
  })
})

/**
 * PATH without any directory holding a `docker` executable, plus `git`: whatever this test
 * spawns can never reach a build, whatever the script's order of checks becomes.
 */
function pathWithoutDocker(): string {
  const bin = mkdtempSync(join(tmpdir(), "factory-no-docker-"))
  dirs.push(bin)
  const git = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()
  symlinkSync(git, join(bin, "git"))
  const kept = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0 && !existsSync(join(entry, "docker")))
  return [bin, ...kept].join(delimiter)
}

function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...argv], {
      cwd: appRoot,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
    child.on("error", reject)
    child.on("close", (status) => {
      clearTimeout(timer)
      resolve({ status, stderr })
    })
  })
}

describe("prepare-target.ts at a pin its paths do not exist at", () => {
  it("refuses cli-flags at HEAD by the path that moved, before any build, writing nothing", async () => {
    // A COPY of the targets directory: the working tree is never the script's to write.
    const copy = mkdtempSync(join(tmpdir(), "factory-prepare-targets-"))
    dirs.push(copy)
    cpSync(join(targetsDir, "cli-flags"), join(copy, "cli-flags"), { recursive: true })
    const manifestPath = join(copy, "cli-flags", "target.json")
    const before = readFileSync(manifestPath, "utf8")
    const head = execFileSync("git", ["-C", repositoryRoot(), "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim()
    const { status, stderr } = await run(
      ["scripts/prepare-target.ts", "cli-flags", "--pin", head],
      {
        ...process.env,
        PATH: pathWithoutDocker(),
        FACTORY_TARGETS_DIR: copy,
      },
    )
    expect(status).not.toBe(0)
    expect(stderr).toContain(
      `Target "cli-flags" names examples/software-factory/server/fixtures/cli-flags/project, which does not exist at ${head}: it cannot be prepared at that pin`,
    )
    expect(readFileSync(manifestPath, "utf8")).toBe(before)
  }, 90_000)
})

describe("a Dockerfile's CAPTURED list against the capture", () => {
  const capture = {
    id: "t",
    capture: {
      include: ["package.json", "packages/a/src", "packages/a/package.json", "packages/b"],
    },
  }
  it("reads the packages a capture includes and the ones a Dockerfile restates", () => {
    expect(capturedPackages(capture)).toEqual(["a", "b"])
    expect(dockerfileCapturedPackages('RUN set -eu \\\n && CAPTURED="b  a" \\\n')).toEqual([
      "b",
      "a",
    ])
    expect(dockerfileCapturedPackages("FROM node\n")).toBeUndefined()
  })

  it("agrees, or names each disagreement", () => {
    expect(capturedListMismatch(capture, 'CAPTURED="a b"')).toBeUndefined()
    expect(capturedListMismatch(capture, "FROM node")).toBeUndefined()
    const message = capturedListMismatch(capture, 'CAPTURED="a c a"')
    expect(message).toContain("captured but not in CAPTURED: b")
    expect(message).toContain("in CAPTURED but not captured: c")
    expect(message).toContain("repeated in CAPTURED: a")
  })

  it("holds for every shipped target", () => {
    for (const id of readdirSync(targetsDir)) {
      const directory = join(targetsDir, id)
      if (!existsSync(join(directory, "target.json"))) continue
      const manifest = TargetSchema.parse(
        JSON.parse(readFileSync(join(directory, "target.json"), "utf8")),
      )
      const dockerfile = readFileSync(join(directory, "Dockerfile"), "utf8")
      expect(capturedListMismatch(manifest, dockerfile), id).toBeUndefined()
    }
    const cli = readFileSync(join(targetsDir, "cli", "Dockerfile"), "utf8")
    expect(dockerfileCapturedPackages(cli)).toHaveLength(11)
  })
})
