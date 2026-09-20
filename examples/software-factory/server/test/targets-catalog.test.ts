import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  assertTaskFitsTarget,
  ChecksSchema,
  covers,
  environmentIdentity,
  imageTag,
  loadTarget,
  loadTargetIds,
  loadTask,
  loadTaskIds,
  overlaps,
  repositoryRoot,
  targetsDir as shippedTargetsDir,
  TargetSchema,
  TaskSchema,
  tasksDir,
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

/**
 * An origin with two commits and a `--depth 1` clone of it, which is the shape of a CI
 * checkout: the clone holds the tip and not the commit a target pins. `file://` (not a bare
 * path) is what makes the clone shallow, and `allowAnySHA1InWant` is what lets a fetch ask
 * for one commit by SHA, as GitHub's servers do.
 */
function shallowClone(): { origin: string; clone: string; older: string } {
  const origin = mkdtempSync(join(tmpdir(), "factory-origin-"))
  dirs.push(origin)
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", origin, ...args], { encoding: "utf8" }).trim()
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  git("config", "uploadpack.allowAnySHA1InWant", "true")
  writeFileSync(join(origin, "a.txt"), "a\n")
  git("add", ".")
  git("commit", "-q", "-m", "one")
  const older = git("rev-parse", "HEAD")
  writeFileSync(join(origin, "a.txt"), "b\n")
  git("commit", "-q", "-a", "-m", "two")
  const clone = mkdtempSync(join(tmpdir(), "factory-clone-"))
  dirs.push(clone)
  rmSync(clone, { recursive: true, force: true })
  execFileSync("git", ["clone", "-q", "--depth", "1", `file://${origin}`, clone], {
    encoding: "utf8",
  })
  return { origin, clone, older }
}

function holdsCommit(root: string, sha: string): boolean {
  try {
    execFileSync("git", ["-C", root, "cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
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

  it("fetches a pin a shallow checkout lacks", () => {
    const { clone, older } = shallowClone()
    expect(holdsCommit(clone, older)).toBe(false)
    const target = loadTarget("t", { targetsDir: targetsDir(older), repositoryRoot: clone })
    expect(target.pin).toBe(older)
    expect(holdsCommit(clone, older)).toBe(true)
  })

  it("refuses a missing pin without fetching when FACTORY_NO_FETCH is set", () => {
    const { clone, older } = shallowClone()
    const previous = process.env.FACTORY_NO_FETCH
    process.env.FACTORY_NO_FETCH = "1"
    try {
      expect(() =>
        loadTarget("t", { targetsDir: targetsDir(older), repositoryRoot: clone }),
      ).toThrow(/not in the repository[\s\S]*FACTORY_NO_FETCH/)
    } finally {
      if (previous === undefined) delete process.env.FACTORY_NO_FETCH
      else process.env.FACTORY_NO_FETCH = previous
    }
    expect(holdsCommit(clone, older)).toBe(false)
  })

  it("reports a failed fetch for a pin that exists nowhere", () => {
    const { clone } = shallowClone()
    expect(() =>
      loadTarget("t", { targetsDir: targetsDir("1".repeat(40)), repositoryRoot: clone }),
    ).toThrow(/fetching it from origin also failed/)
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

/** Write a tasks directory holding one task against target `t`. */
function tasksDirFor(
  overrides: Record<string, unknown> = {},
  files: Record<string, string> = {},
  checksOverrides: Record<string, unknown> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-tasks-"))
  dirs.push(dir)
  mkdirSync(join(dir, "k", "checks"), { recursive: true })
  writeFileSync(
    join(dir, "k", "task.json"),
    JSON.stringify({
      id: "k",
      target: "t",
      allowedSourcePaths: ["src/a.ts"],
      immutablePaths: ["package.json", "test/a.test.ts"],
      ...overrides,
    }),
  )
  writeFileSync(
    join(dir, "k", "checks.json"),
    JSON.stringify({
      visible: { runner: "vitest", assertions: ["a passes"] },
      independent: { runner: "node-test", file: "checks/k.test.ts", assertions: ["A1"] },
      ...checksOverrides,
    }),
  )
  writeFileSync(join(dir, "k", "spec.md"), "# k\n\nA1: something holds.\n")
  writeFileSync(join(dir, "k", "reference.patch"), "--- a/src/a.ts\n+++ b/src/a.ts\n")
  writeFileSync(join(dir, "k", "checks", "k.test.ts"), "")
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, "k", name), content)
  return dir
}

describe("task catalog", () => {
  it("lists the tasks shipped with the factory", () => {
    expect(loadTaskIds()).toEqual(["cli-flags", "devkit-spawn-deadline"])
  })

  it("loads a task with its target, spec, checks and patches", () => {
    const { root, pin } = repo()
    const task = loadTask("k", {
      targetsDir: targetsDir(pin),
      tasksDir: tasksDirFor({}, { "defect.patch": "--- a/src/a.ts\n+++ b/src/a.ts\n" }),
      repositoryRoot: root,
    })
    expect(task.target.id).toBe("t")
    expect(task.specText).toMatch(/A1/)
    expect(task.checks.visible.runner).toBe("vitest")
    expect(task.defectPatch).toMatch(/^--- a/)
    expect(task.referencePatch).toMatch(/^--- a/)
    expect(task.directory.endsWith("/k")).toBe(true)
  })

  it("treats a missing defect patch as a baseline that is already defective", () => {
    const { root, pin } = repo()
    const task = loadTask("k", {
      targetsDir: targetsDir(pin),
      tasksDir: tasksDirFor(),
      repositoryRoot: root,
    })
    expect(task.defectPatch).toBeNull()
  })

  it("refuses an allowed path that is a test, a check, or overlaps immutable", () => {
    expect(
      TaskSchema.safeParse({
        id: "k",
        target: "t",
        allowedSourcePaths: ["test/a.test.ts"],
        immutablePaths: [],
      }).success,
    ).toBe(false)
    expect(
      TaskSchema.safeParse({
        id: "k",
        target: "t",
        allowedSourcePaths: ["checks/k.test.ts"],
        immutablePaths: [],
      }).success,
    ).toBe(false)
    expect(
      TaskSchema.safeParse({
        id: "k",
        target: "t",
        allowedSourcePaths: ["src/a.ts"],
        immutablePaths: ["src/a.ts"],
      }).success,
    ).toBe(false)
    // An allowed path UNDER an immutable directory overlaps too.
    expect(
      TaskSchema.safeParse({
        id: "k",
        target: "t",
        allowedSourcePaths: ["src/a.ts"],
        immutablePaths: ["src"],
      }).success,
    ).toBe(false)
  })

  it("refuses a task that may edit the target's runner configuration, including a file under a configured directory", () => {
    const { root, pin } = repo()
    expect(() =>
      loadTask("k", {
        targetsDir: targetsDir(pin),
        tasksDir: tasksDirFor({ allowedSourcePaths: ["package.json"], immutablePaths: [] }),
        repositoryRoot: root,
      }),
    ).toThrow(/runner configuration/)
    // immutablePaths is empty here, not ["config"]: the disjointness refine would reject
    // an allowed path nested under an immutable directory before this check ever ran, and
    // that precedence (a schema-level defect over a cross-catalog one) is intended.
    expect(() =>
      loadTask("k", {
        targetsDir: targetsDir(pin, { runnerConfig: ["config"] }),
        tasksDir: tasksDirFor({
          allowedSourcePaths: ["config/base.json"],
          immutablePaths: [],
        }),
        repositoryRoot: root,
      }),
    ).toThrow(/runner configuration/)
  })

  it("refuses a task that leaves a runner configuration file mutable, and accepts one covered by an immutable directory", () => {
    const { root, pin } = repo()
    expect(() =>
      loadTask("k", {
        targetsDir: targetsDir(pin),
        tasksDir: tasksDirFor({ immutablePaths: ["test/a.test.ts"] }),
        repositoryRoot: root,
      }),
    ).toThrow(/must be immutable/)
    const covered = loadTask("k", {
      targetsDir: targetsDir(pin, { runnerConfig: ["config/base.json"] }),
      tasksDir: tasksDirFor({ immutablePaths: ["config"] }),
      repositoryRoot: root,
    })
    expect(covered.id).toBe("k")
  })

  it("refuses an independent check that is not a node-test suite, or whose file is missing", () => {
    expect(
      ChecksSchema.safeParse({
        visible: { runner: "vitest", assertions: ["x"] },
        independent: { runner: "vitest", assertions: ["x"] },
      }).success,
    ).toBe(false)
    const { root, pin } = repo()
    const dir = tasksDirFor()
    rmSync(join(dir, "k", "checks", "k.test.ts"))
    expect(() =>
      loadTask("k", { targetsDir: targetsDir(pin), tasksDir: dir, repositoryRoot: root }),
    ).toThrow(/checks\/k.test.ts/)
  })

  it("refuses an unknown task and an id that disagrees with its directory", () => {
    const { root, pin } = repo()
    const dir = tasksDirFor({ id: "other" })
    expect(() =>
      loadTask("nope", { targetsDir: targetsDir(pin), tasksDir: dir, repositoryRoot: root }),
    ).toThrow(/Unknown task: nope/)
    expect(() =>
      loadTask("k", { targetsDir: targetsDir(pin), tasksDir: dir, repositoryRoot: root }),
    ).toThrow(/declares a different id/)
  })

  it("refuses an allowed directory that contains an immutable file", () => {
    // Neither path covers the other outright, but the directory swallows the file: overlap
    // has to be checked in both directions, not just "does the immutable list cover the path".
    expect(
      TaskSchema.safeParse({
        id: "k",
        target: "t",
        allowedSourcePaths: ["src"],
        immutablePaths: ["src/memory.ts"],
      }).success,
    ).toBe(false)
  })

  it("refuses a bare `checks` entry and a .test.mjs file as allowed source paths", () => {
    expect(
      TaskSchema.safeParse({
        id: "k",
        target: "t",
        allowedSourcePaths: ["checks"],
        immutablePaths: [],
      }).success,
    ).toBe(false)
    expect(
      TaskSchema.safeParse({
        id: "k",
        target: "t",
        allowedSourcePaths: ["test/a.test.mjs"],
        immutablePaths: [],
      }).success,
    ).toBe(false)
  })

  it("refuses an unknown top-level key on the task manifest and the checks file", () => {
    expect(
      TaskSchema.safeParse({
        id: "k",
        target: "t",
        allowedSourcePaths: ["src/a.ts"],
        immutablePaths: [],
        version: 1,
      }).success,
    ).toBe(false)
    expect(
      ChecksSchema.safeParse({
        visible: { runner: "vitest", assertions: ["x"] },
        independent: { runner: "node-test", file: "checks/k.test.ts", assertions: ["x"] },
        version: 1,
      }).success,
    ).toBe(false)
  })

  it("refuses an independent check file with a `..` segment or living outside checks/", () => {
    expect(
      ChecksSchema.safeParse({
        visible: { runner: "vitest", assertions: ["x"] },
        independent: { runner: "node-test", file: "checks/../x.test.ts", assertions: ["x"] },
      }).success,
    ).toBe(false)
    expect(
      ChecksSchema.safeParse({
        visible: { runner: "vitest", assertions: ["x"] },
        independent: { runner: "node-test", file: "test/a.test.ts", assertions: ["x"] },
      }).success,
    ).toBe(false)
  })

  it("accepts a visible node-test suite anywhere outside checks/, monorepo paths included", () => {
    expect(
      ChecksSchema.safeParse({
        visible: {
          runner: "node-test",
          file: "packages/devkit/test/x.test.ts",
          assertions: ["x"],
        },
        independent: { runner: "node-test", file: "checks/k.test.ts", assertions: ["x"] },
      }).success,
    ).toBe(true)
  })

  it("refuses a node-test visible suite that is not itself immutable", () => {
    const { root, pin } = repo()
    expect(() =>
      loadTask("k", {
        targetsDir: targetsDir(pin),
        tasksDir: tasksDirFor(
          {},
          {},
          { visible: { runner: "node-test", file: "test/b.test.ts", assertions: ["a passes"] } },
        ),
        repositoryRoot: root,
      }),
    ).toThrow(/must be immutable/)
  })
})

describe("covers", () => {
  it("is a prefix-aware, directory-or-file coverage test", () => {
    expect(covers(["src"], "src/a.ts")).toBe(true)
    expect(covers(["src"], "src-notes.ts")).toBe(false)
    expect(covers(["src"], "src")).toBe(true)
    expect(covers(["src"], "srcx/a.ts")).toBe(false)
  })
})

describe("overlaps", () => {
  it("is symmetric: it does not matter which side is the directory", () => {
    expect(overlaps("src", "src/a.ts")).toBe(true)
    expect(overlaps("src/a.ts", "src")).toBe(true)
    expect(overlaps("src", "other")).toBe(false)
  })
})

describe("shipped tasks", () => {
  for (const id of loadTaskIds()) {
    it(`${id}: parses, names a known target, fits it, and has its files on disk`, () => {
      // loadTask needs a prepared target (an image), which arrives later; parse the pieces
      // directly and check the fit against the raw target manifest instead.
      const dir = join(tasksDir, id)
      const manifest = TaskSchema.parse(JSON.parse(readFileSync(join(dir, "task.json"), "utf8")))
      expect(manifest.id).toBe(id)
      expect(loadTargetIds()).toContain(manifest.target)
      const checks = ChecksSchema.parse(JSON.parse(readFileSync(join(dir, "checks.json"), "utf8")))
      const target = TargetSchema.parse(
        JSON.parse(readFileSync(join(shippedTargetsDir, manifest.target, "target.json"), "utf8")),
      )
      assertTaskFitsTarget(id, manifest, checks, target)
      expect(existsSync(join(dir, checks.independent.file))).toBe(true)
      expect(existsSync(join(dir, "spec.md"))).toBe(true)
      expect(existsSync(join(dir, "reference.patch"))).toBe(true)
    })
  }
})
