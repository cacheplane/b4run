import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  environmentIdentity,
  imageTag,
  loadTarget,
  loadTargetIds,
  repositoryRoot,
  targetsDir as shippedTargetsDir,
  TargetSchema,
} from "../src/targets/catalog.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A throwaway repository with one commit, so a pin can be real without touching this repo. */
function repo(): { root: string; pin: string } {
  const root = mkdtempSync(join(tmpdir(), "factory-targets-repo-"))
  dirs.push(root)
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  writeFileSync(join(root, "a.txt"), "a\n")
  git("add", ".")
  git("commit", "-q", "-m", "one")
  return { root, pin: git("rev-parse", "HEAD") }
}

const image = {
  localId: `sha256:${"a".repeat(64)}`,
  platform: "linux/arm64",
  baseManifestDigest: `sha256:${"b".repeat(64)}`,
  dockerfileSha256: "c".repeat(64),
  lockfileSha256: "d".repeat(64),
  pnpmVersion: "10.33.0",
}

function manifest(pin: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "t",
    pin,
    root: ".",
    capture: { include: ["a.txt"] },
    snapshotIgnore: [],
    image,
    imageContext: ["package.json"],
    lockfile: "pnpm-lock.yaml",
    imageAssertResolves: [],
    environmentLinks: [{ path: "node_modules", target: "/opt/targets/t/node_modules" }],
    commands: {
      cwd: ".",
      build: [],
      test: ["pnpm", "exec", "vitest", "--run"],
      nodeTestExecArgv: [],
    },
    runnerConfig: ["package.json"],
    resources: { memoryMb: 1024, cpus: 1, commandTimeoutMs: 120_000, verifierDeadlineMs: 300_000 },
    ...overrides,
  }
}

/** Write a targets directory holding one target manifest. */
function targetsDir(pin: string, overrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-targets-"))
  dirs.push(dir)
  mkdirSync(join(dir, "t"))
  writeFileSync(join(dir, "t", "target.json"), JSON.stringify(manifest(pin, overrides)))
  return dir
}

describe("target catalog", () => {
  it("lists the targets shipped with the factory", () => {
    expect(loadTargetIds()).toEqual(["cli-flags", "devkit"])
  })

  it("loads a target whose pin the repository holds", () => {
    const { root, pin } = repo()
    const target = loadTarget("t", { targetsDir: targetsDir(pin), repositoryRoot: root })
    expect(target.pin).toBe(pin)
    expect(target.directory.endsWith("/t")).toBe(true)
    expect(imageTag(target)).toBe(`b4-factory-t:${pin.slice(0, 12)}-${"c".repeat(12)}`)
    expect(environmentIdentity(target)).toMatch(/^[a-f0-9]{64}$/)
  })

  it("refuses a pin that is not a full commit sha", () => {
    expect(TargetSchema.safeParse(manifest("abc123")).success).toBe(false)
    expect(TargetSchema.safeParse(manifest("A".repeat(40))).success).toBe(false)
  })

  it("refuses a pin the repository's object store does not contain", () => {
    const { root } = repo()
    const absent = "1".repeat(40)
    expect(() => loadTarget("t", { targetsDir: targetsDir(absent), repositoryRoot: root })).toThrow(
      /not in the repository/,
    )
  })

  it("refuses a target that has not been prepared", () => {
    const { root, pin } = repo()
    expect(() =>
      loadTarget("t", { targetsDir: targetsDir(pin, { image: undefined }), repositoryRoot: root }),
    ).toThrow(/not been prepared/)
  })

  it("refuses an unknown target and an id that disagrees with its directory", () => {
    const { root, pin } = repo()
    const dir = targetsDir(pin, { id: "other" })
    expect(() => loadTarget("nope", { targetsDir: dir, repositoryRoot: root })).toThrow(
      /Unknown target: nope/,
    )
    expect(() => loadTarget("t", { targetsDir: dir, repositoryRoot: root })).toThrow(
      /declares a different id/,
    )
  })

  it("refuses a root or an include path that escapes or is absolute", () => {
    expect(TargetSchema.safeParse(manifest("1".repeat(40), { root: "../x" })).success).toBe(false)
    expect(TargetSchema.safeParse(manifest("1".repeat(40), { root: "/x" })).success).toBe(false)
    expect(
      TargetSchema.safeParse(manifest("1".repeat(40), { capture: { include: ["../a"] } })).success,
    ).toBe(false)
  })

  it("refuses a path without one canonical spelling, and a snapshot ignore entry without a trailing slash", () => {
    const pin = "1".repeat(40)
    for (const bad of ["a/./b", "a//b", "src/", "."]) {
      expect(TargetSchema.safeParse(manifest(pin, { capture: { include: [bad] } })).success).toBe(
        false,
      )
    }
    expect(TargetSchema.safeParse(manifest(pin, { snapshotIgnore: ["dist"] })).success).toBe(false)
    expect(TargetSchema.safeParse(manifest(pin, { snapshotIgnore: ["dist/"] })).success).toBe(true)
  })

  it("refuses an unknown top-level key", () => {
    const pin = "1".repeat(40)
    expect(TargetSchema.safeParse({ ...manifest(pin), extra: "nope" }).success).toBe(false)
  })

  it("resolves FACTORY_REPO_ROOT when set, and a real repository root otherwise", () => {
    const prior = process.env.FACTORY_REPO_ROOT
    try {
      process.env.FACTORY_REPO_ROOT = "/some/configured/root"
      expect(repositoryRoot()).toBe("/some/configured/root")

      delete process.env.FACTORY_REPO_ROOT
      const root = repositoryRoot()
      expect(existsSync(join(root, ".git"))).toBe(true)
    } finally {
      if (prior === undefined) delete process.env.FACTORY_REPO_ROOT
      else process.env.FACTORY_REPO_ROOT = prior
    }
  })

  describe("shipped manifests", () => {
    for (const id of loadTargetIds()) {
      it(`parses ${id} and its pin exists in this repository`, () => {
        const directory = join(shippedTargetsDir, id)
        const parsed = TargetSchema.parse(
          JSON.parse(readFileSync(join(directory, "target.json"), "utf8")),
        )
        expect(parsed.id).toBe(id)

        const root = repositoryRoot()
        expect(() =>
          execFileSync("git", ["-C", root, "cat-file", "-e", `${parsed.pin}^{commit}`], {
            stdio: "ignore",
          }),
        ).not.toThrow()

        if (parsed.image) {
          const dockerfile = readFileSync(join(directory, "Dockerfile"))
          const sha256 = createHash("sha256").update(dockerfile).digest("hex")
          expect(parsed.image.dockerfileSha256).toBe(sha256)
        }
      })
    }
  })
})
