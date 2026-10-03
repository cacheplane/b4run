import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  assertTaskFitsTarget,
  ChecksSchema,
  covers,
  ensurePin,
  environmentIdentity,
  ImageNotBuiltError,
  ImagesUnconfiguredError,
  idTagFor,
  loadTarget,
  loadTargetIds,
  loadTargetRecipe,
  loadTask,
  loadTaskIds,
  loadTaskRecipe,
  overlaps,
  PLACEHOLDER_RESOURCES,
  repositoryRoot,
  targetsDir as shippedTargetsDir,
  type TargetRecipe,
  TargetSchema,
  TaskSchema,
  tagFor,
  tasksDir,
  UnknownTargetError,
} from "../src/lib/targets/catalog.ts"
import { type ImageRegistry, imageTag, recipeKey } from "../src/lib/targets/images.ts"
import { emptyImageRegistry, useImages } from "./static-images.ts"

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

const BASE_IMAGE = `node:24-slim@sha256:${"e".repeat(64)}`

function manifest(pin: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "t",
    pin,
    root: ".",
    capture: { include: ["a.txt"] },
    snapshotIgnore: [],
    baseImage: BASE_IMAGE,
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

/** A throwaway repository with two commits: two pins a target can hold images at. */
function twoCommitRepo(): { root: string; first: string; second: string } {
  const { root, pin: first } = repo()
  writeFileSync(join(root, "a.txt"), "b\n")
  execFileSync("git", ["-C", root, "commit", "-q", "-a", "-m", "two"])
  const second = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  return { root, first, second }
}

/** Write a targets directory holding one target manifest. */
function targetsDir(pin: string, overrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-targets-"))
  dirs.push(dir)
  mkdirSync(join(dir, "t"))
  writeFileSync(join(dir, "t", "target.json"), JSON.stringify(manifest(pin, overrides)))
  writeFileSync(join(dir, "t", "Dockerfile"), "FROM scratch\n")
  return dir
}

/**
 * An origin with three commits and a `--depth 1` clone of it, which is the shape of a CI
 * checkout: the clone holds the tip and not the commit a target pins. `file://` (not a bare
 * path) is what makes the clone shallow, and `allowAnySHA1InWant` is what lets a fetch ask
 * for one commit by SHA, as GitHub's servers do.
 */
function shallowClone(): { origin: string; clone: string; older: string; middle: string } {
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
  const middle = git("rev-parse", "HEAD")
  writeFileSync(join(origin, "a.txt"), "b2\n")
  git("commit", "-q", "-a", "-m", "two and a half")
  const clone = mkdtempSync(join(tmpdir(), "factory-clone-"))
  dirs.push(clone)
  rmSync(clone, { recursive: true, force: true })
  execFileSync("git", ["clone", "-q", "--depth", "1", `file://${origin}`, clone], {
    encoding: "utf8",
  })
  return { origin, clone, older, middle }
}

/**
 * A FULL clone of an origin that then gains a commit the clone lacks: the operator's
 * checkout, behind origin. `ensurePin` of that commit must not make it shallow.
 */
function fullCloneBehind(): { clone: string; newer: string } {
  const { origin } = shallowClone()
  const clone = mkdtempSync(join(tmpdir(), "factory-full-clone-"))
  dirs.push(clone)
  rmSync(clone, { recursive: true, force: true })
  execFileSync("git", ["clone", "-q", `file://${origin}`, clone], { encoding: "utf8" })
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", origin, ...args], { encoding: "utf8" }).trim()
  writeFileSync(join(origin, "a.txt"), "c\n")
  git("commit", "-q", "-a", "-m", "three")
  return { clone, newer: git("rev-parse", "HEAD") }
}

function isShallow(root: string): boolean {
  return (
    execFileSync("git", ["-C", root, "rev-parse", "--is-shallow-repository"], {
      encoding: "utf8",
    }).trim() === "true"
  )
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
  it("requires the base image pinned by digest", () => {
    const { pin } = repo()
    for (const baseImage of ["node:24-slim", "node@sha256:abc", `Node:24@sha256:${"e".repeat(64)}`])
      expect(TargetSchema.safeParse(manifest(pin, { baseImage })).success, baseImage).toBe(false)
    const { baseImage: _omitted, ...without } = manifest(pin)
    expect(TargetSchema.safeParse(without).success).toBe(false)
    for (const baseImage of [
      BASE_IMAGE,
      `node@sha256:${"e".repeat(64)}`,
      `docker.io/library/node:24-slim@sha256:${"e".repeat(64)}`,
    ])
      expect(TargetSchema.safeParse(manifest(pin, { baseImage })).success, baseImage).toBe(true)
  })

  it("loads a target's recipe at a pin without its image", () => {
    const { root, first, second } = twoCommitRepo()
    const dir = targetsDir(first)
    const recipe = loadTargetRecipe("t", { targetsDir: dir, repositoryRoot: root, pin: second })
    expect(recipe.pin).toBe(second)
    expect(recipe.directory).toBe(join(dir, "t"))
    expect(recipe.baseImage).toBe(BASE_IMAGE)
    expect(recipe).not.toHaveProperty("image")
    expect(recipe).not.toHaveProperty("images")
    expect(loadTargetRecipe("t", { targetsDir: dir, repositoryRoot: root }).pin).toBe(first)
    expect(() => loadTargetRecipe("nope", { targetsDir: dir, repositoryRoot: root })).toThrow(
      UnknownTargetError,
    )
  })

  it("names a recipe tag after the target, the pin and the recipe key, and an id tag that never moves", () => {
    const pin = "1".repeat(40)
    const key = "c".repeat(64)
    expect(tagFor("devkit", pin, key)).toBe(`b4-factory-devkit:${"1".repeat(12)}-${"c".repeat(12)}`)
    expect(idTagFor("devkit", pin, key, `sha256:${"9".repeat(64)}`)).toBe(
      `b4-factory-devkit:${"1".repeat(12)}-${"c".repeat(12)}-${"9".repeat(12)}`,
    )
  })

  it("lists the targets shipped with the factory", () => {
    expect(loadTargetIds()).toEqual(["cli", "cli-flags", "devkit"])
  })

  it("loads a target whose pin the repository holds", () => {
    const { root, pin } = repo()
    const target = loadTarget("t", { targetsDir: targetsDir(pin), repositoryRoot: root })
    expect(target.pin).toBe(pin)
    expect(target.directory.endsWith("/t")).toBe(true)
    expect(imageTag(target)).toBe(tagFor("t", pin, recipeKey(target, target.image.platform)))
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

  it("never makes a full clone shallow when it fetches a missing pin", () => {
    const { clone, newer } = fullCloneBehind()
    expect(isShallow(clone)).toBe(false)
    expect(holdsCommit(clone, newer)).toBe(false)
    ensurePin(clone, "t", newer)
    expect(holdsCommit(clone, newer)).toBe(true)
    expect(isShallow(clone)).toBe(false)
    expect(existsSync(join(clone, ".git", "shallow"))).toBe(false)
  })

  it("fetches a missing pin into a shallow clone by sha, and it stays shallow", () => {
    // The pin has a parent: `--depth=1` fetches it alone and marks it a shallow boundary, where
    // a plain fetch would pull its whole history (the root commit) and leave no mark on it.
    const { clone, older, middle } = shallowClone()
    expect(isShallow(clone)).toBe(true)
    ensurePin(clone, "t", middle)
    expect(holdsCommit(clone, middle)).toBe(true)
    expect(holdsCommit(clone, older)).toBe(false)
    expect(isShallow(clone)).toBe(true)
    const boundaries = readFileSync(join(clone, ".git", "shallow"), "utf8").split("\n")
    expect(boundaries).toContain(middle)
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

  /** A registry answering every recipe with `answer(recipe)`, recording the pins it was asked. */
  function lookup(answer: (recipe: TargetRecipe) => typeof image | undefined) {
    const asked: string[] = []
    const registry: ImageRegistry = {
      recorded(recipe) {
        asked.push(recipe.pin)
        const found = answer(recipe)
        return found === undefined ? undefined : { key: "k", tag: "t", image: found }
      },
      async ensure() {
        throw new Error("unused")
      },
      async present() {
        return true
      },
      close() {},
    }
    return { registry, asked }
  }

  it("reads a target's image from the configured registry, at the pin asked for", () => {
    const { root, first, second } = twoCommitRepo()
    const dir = targetsDir(first)
    const other = {
      ...image,
      localId: `sha256:${"9".repeat(64)}`,
      dockerfileSha256: "8".repeat(64),
    }
    const { registry, asked } = lookup((recipe) => (recipe.pin === first ? image : other))
    const restore = useImages(registry)
    try {
      expect(loadTarget("t", { targetsDir: dir, repositoryRoot: root }).image).toEqual(image)
      const atSecond = loadTarget("t", { targetsDir: dir, repositoryRoot: root, pin: second })
      expect(atSecond.image).toEqual(other)
      expect(imageTag(atSecond)).toBe(
        tagFor("t", second, recipeKey(atSecond, atSecond.image.platform)),
      )
      expect(asked).toEqual([first, second])
    } finally {
      restore()
    }
  })

  it("names who builds an image the registry does not hold, and refuses to load without a registry", () => {
    const { root, pin } = repo()
    const dir = targetsDir(pin)
    const restoreEmpty = useImages(emptyImageRegistry())
    try {
      let caught: unknown
      try {
        loadTarget("t", { targetsDir: dir, repositoryRoot: root })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(ImageNotBuiltError)
      expect(caught).toMatchObject({ targetId: "t", pin })
      expect(String((caught as Error).message)).toBe(
        `Target t has no image built at ${pin} on this host yet: the controller builds it when a work order first needs it (or warm it with pnpm --filter @b4-example/software-factory-controller target:prepare t --pin ${pin})`,
      )
      // The recipe loads regardless: nothing about it needs an image.
      expect(loadTargetRecipe("t", { targetsDir: dir, repositoryRoot: root }).pin).toBe(pin)
    } finally {
      restoreEmpty()
    }
    const restoreNone = useImages(undefined as unknown as ImageRegistry)
    try {
      expect(() => loadTarget("t", { targetsDir: dir, repositoryRoot: root })).toThrow(
        ImagesUnconfiguredError,
      )
    } finally {
      restoreNone()
    }
  })

  it("loads a target with the image it is given, without asking the registry", () => {
    const { root, pin } = repo()
    const restore = useImages(emptyImageRegistry())
    try {
      const target = loadTarget("t", { targetsDir: targetsDir(pin), repositoryRoot: root, image })
      expect(target.image).toEqual(image)
    } finally {
      restore()
    }
  })

  it("refuses a target.json that still records images, saying where they live now", () => {
    const { pin } = repo()
    for (const key of ["image", "images"]) {
      const result = TargetSchema.safeParse({
        ...manifest(pin),
        [key]: key === "image" ? image : { [pin]: image },
      })
      expect(result.success).toBe(false)
      // The one issue: a preprocess issue stops the parse before the strict shape's own.
      expect(result.error?.issues.map((issue) => issue.message)).toEqual([
        `"${key}" is retired: images are built when a work order first needs them and recorded in <FACTORY_STATE_DIR>/images.sqlite, never in the target. Delete the key`,
      ])
    }
  })

  it("gives two pins with identical image inputs two environment identities", () => {
    const { root, first, second } = twoCommitRepo()
    const dir = targetsDir(first)
    const restore = useImages(lookup(() => image).registry)
    try {
      const a = loadTarget("t", { targetsDir: dir, repositoryRoot: root, pin: first })
      const b = loadTarget("t", { targetsDir: dir, repositoryRoot: root, pin: second })
      expect(environmentIdentity(a)).not.toBe(environmentIdentity(b))
    } finally {
      restore()
    }
  })

  it("loads a task without an image where the registry has none", () => {
    const restore = useImages(emptyImageRegistry())
    try {
      const recipe = loadTaskRecipe("devkit-spawn-deadline")
      expect(recipe.target.id).toBe("devkit")
      expect(recipe.target).not.toHaveProperty("image")
      expect(() => loadTask("devkit-spawn-deadline")).toThrow(ImageNotBuiltError)
    } finally {
      restore()
    }
  })

  it("refuses an unknown target and an id that disagrees with its directory", () => {
    const { root, pin } = repo()
    const dir = targetsDir(pin, { id: "other" })
    expect(() => loadTarget("nope", { targetsDir: dir, repositoryRoot: root })).toThrow(
      UnknownTargetError,
    )
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
        // One base for every shipped target: the drafter's, pinned by digest (plan D3).
        expect(parsed.baseImage).toBe(
          "node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6",
        )

        const root = repositoryRoot()
        expect(() =>
          execFileSync("git", ["-C", root, "cat-file", "-e", `${parsed.pin}^{commit}`], {
            stdio: "ignore",
          }),
        ).not.toThrow()

        // No image is recorded in the repository: images are this host's (plan D3).
        const raw = JSON.parse(readFileSync(join(directory, "target.json"), "utf8"))
        expect(raw).not.toHaveProperty("image")
        expect(raw).not.toHaveProperty("images")
        expect(existsSync(join(directory, "Dockerfile"))).toBe(true)
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
  it("loads a task without its image, where loadTask needs one", () => {
    const { root, pin } = repo()
    // A target with no image at the pin: loadTask cannot load it, loadTaskRecipe can.
    const targets = targetsDir(pin)
    const tasks = tasksDirFor()
    const options = { targetsDir: targets, tasksDir: tasks, repositoryRoot: root }
    const restore = useImages(emptyImageRegistry())
    try {
      expect(() => loadTask("k", options)).toThrow(ImageNotBuiltError)
    } finally {
      restore()
    }
    const recipe = loadTaskRecipe("k", options)
    expect(recipe.id).toBe("k")
    expect(recipe.target.id).toBe("t")
    expect(recipe.target.pin).toBe(pin)
    expect(recipe.target).not.toHaveProperty("image")
    expect(recipe.checks.independent.file).toBe("checks/k.test.ts")
    expect(recipe.specText).toContain("A1:")
  })

  it("refuses a task on a target whose resources are target:init's placeholders", () => {
    const { root, pin } = repo()
    const targets = targetsDir(pin, { resources: PLACEHOLDER_RESOURCES })
    const options = { targetsDir: targets, tasksDir: tasksDirFor(), repositoryRoot: root }
    expect(() => loadTaskRecipe("k", options)).toThrow(
      'Task k: Target "t"\'s resources are placeholders: run target:measure',
    )
    // The target itself still loads: target:measure builds and runs it to measure them.
    expect(loadTargetRecipe("t", options).resources).toEqual(PLACEHOLDER_RESOURCES)
  })

  it("lists the tasks shipped with the factory", () => {
    expect(loadTaskIds()).toEqual(["cli-flags", "cli-runs-wait-undefined", "devkit-spawn-deadline"])
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

  it("lists every problem a task has with its target in one refusal", () => {
    const checks = ChecksSchema.parse({
      visible: { runner: "node-test", file: "test/v.test.ts", assertions: ["v"] },
      independent: { runner: "node-test", file: "checks/i.test.ts", assertions: ["A1: i"] },
    })
    const attempt = () =>
      assertTaskFitsTarget(
        "k",
        { id: "k", target: "t", allowedSourcePaths: ["config/base.json"], immutablePaths: [] },
        checks,
        { runnerConfig: ["config", "package.json"] },
      )
    expect(attempt).toThrow(/Task k does not fit its target \(4 problems\)/)
    let message = ""
    try {
      attempt()
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain(
      "may edit config/base.json, which reaches the target's runner configuration (config)",
    )
    expect(message).toContain("runner configuration config must be immutable")
    expect(message).toContain("runner configuration package.json must be immutable")
    expect(message).toContain("visible suite test/v.test.ts must be immutable")
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

  it("lets a vitest suite name no assertions (the whole suite must pass), a node-test suite not", () => {
    const independent = { runner: "node-test", file: "checks/k.test.ts", assertions: ["A1: x"] }
    expect(
      ChecksSchema.safeParse({ visible: { runner: "vitest", assertions: [] }, independent })
        .success,
    ).toBe(true)
    expect(
      ChecksSchema.safeParse({
        visible: { runner: "node-test", file: "test/b.test.ts", assertions: [] },
        independent,
      }).success,
    ).toBe(false)
    expect(
      ChecksSchema.safeParse({
        visible: { runner: "vitest", assertions: [] },
        independent: { ...independent, assertions: [] },
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
