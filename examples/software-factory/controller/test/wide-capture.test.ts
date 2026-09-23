import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureWorkspaceDefinition } from "@b4run/workspace/node"
import { afterEach, describe, expect, it } from "vitest"
import { repositoryRoot } from "../src/lib/targets/catalog.ts"
import {
  stageWideCapture,
  WIDE_CAPTURE_ROOT,
  wideCaptureInclude,
} from "../src/lib/targets/wide-capture.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()

/**
 * A repository shaped like this one at the top level: one file of every kind the include
 * rules decide about, so each rule is exercised by name rather than by whatever the live
 * tree happens to contain.
 */
function repo(): { root: string; pin: string } {
  const root = mkdtempSync(join(tmpdir(), "factory-wide-repo-"))
  dirs.push(root)
  git(root, "init", "-q")
  git(root, "config", "user.email", "t@example.com")
  git(root, "config", "user.name", "t")
  const write = (path: string, text = `${path}\n`) => {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  // Root manifests: in.
  for (const name of [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "turbo.json",
    "tsconfig.json",
    "tsconfig.base.json",
    "biome.json",
    ".npmrc",
  ])
    write(name)
  // Other root files: out.
  write("README.md")
  write("CONTRIBUTING.md")
  write(".gitignore")
  // A package: manifests, sources and tests in; build output, changelog and fixtures out.
  write("packages/cli/package.json")
  write("packages/cli/tsconfig.json")
  write("packages/cli/tsconfig.build.json")
  write("packages/cli/README.md")
  write("packages/cli/CHANGELOG.md")
  write("packages/cli/src/index.ts")
  write("packages/cli/src/deep/nested/module.ts")
  write("packages/cli/test/index.test.ts")
  write("packages/cli/test/fixtures/sample.txt")
  write("packages/cli/dist/index.js")
  write("packages/cli/vitest.config.ts")
  // Scripts: in, executable bit and all; release fixtures out.
  write("scripts/check-docs.mjs")
  write("scripts/run.sh", "#!/bin/sh\necho hi\n")
  write("scripts/release/test/fixtures/archive.tar.gz", "binary")
  write("scripts/release/test/workflow.test.mjs")
  // Not targets: out.
  write("apps/web/package.json")
  write("examples/chat/server/src/index.ts")
  write("docs/superpowers/plan.md")
  write("test/harness.mjs")
  // The drafter creates draft/ itself; a committed one must never be staged over it.
  write("draft/task.json")
  // A path the framework's capture would refuse: dropped by rule, not by a capture failure.
  write("packages/cli/src/naïve.ts")
  git(root, "add", "-A")
  git(root, "update-index", "--chmod=+x", "scripts/run.sh")
  git(root, "commit", "-q", "-m", "one")
  const pin = git(root, "rev-parse", "HEAD")
  // The working tree is not the source: a dirty edit and an untracked file stay invisible.
  writeFileSync(join(root, "packages/cli/src/index.ts"), "dirty\n")
  write("packages/cli/src/untracked.ts")
  return { root, pin }
}

const EXPECTED = [
  ".npmrc",
  "biome.json",
  "package.json",
  "packages/cli/README.md",
  "packages/cli/package.json",
  "packages/cli/src/deep/nested/module.ts",
  "packages/cli/src/index.ts",
  "packages/cli/test/fixtures/sample.txt",
  "packages/cli/test/index.test.ts",
  "packages/cli/tsconfig.build.json",
  "packages/cli/tsconfig.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/check-docs.mjs",
  "scripts/release/test/workflow.test.mjs",
  "scripts/run.sh",
  "tsconfig.base.json",
  "tsconfig.json",
  "turbo.json",
]

describe("wideCaptureInclude", () => {
  it("selects exactly the sources, tests, manifests and scripts at the pin, sorted", () => {
    const { root, pin } = repo()
    expect(wideCaptureInclude(root, pin)).toEqual(EXPECTED)
  })

  it("on the live HEAD, is a wide but bounded, portable, binary-free list", () => {
    const root = repositoryRoot()
    const include = wideCaptureInclude(root, git(root, "rev-parse", "HEAD"))
    expect(include.length).toBeGreaterThan(1_000)
    expect(include.length).toBeLessThan(3_000)
    expect(include).toEqual([...include].sort())
    expect(include).toContain("package.json")
    expect(include).toContain("packages/cli/src/index.ts")
    for (const path of include) {
      expect(path).toMatch(/^[A-Za-z0-9._ /-]+$/)
      expect(path).not.toContain("node_modules")
      expect(path).not.toMatch(/\.tar\.gz$/)
      expect(path).not.toMatch(/^(apps|examples|docs)\//)
      expect(path).not.toMatch(/^scripts\/release\/test\/fixtures\//)
    }
  })

  it("refuses a pin that is not a full commit sha before touching git", () => {
    expect(() => wideCaptureInclude("/nonexistent", "HEAD")).toThrow(/pin/)
  })
})

describe("stageWideCapture", () => {
  it("archives the include under repo/ and describes it as a baseline-free workspace", () => {
    const { root, pin } = repo()
    const appRoot = mkdtempSync(join(tmpdir(), "factory-wide-app-"))
    dirs.push(appRoot)
    const instanceDir = ".factory/captures/drafter/wo-1.abc"
    const definition = stageWideCapture(root, pin, instanceDir, { appRoot })
    expect(WIDE_CAPTURE_ROOT).toBe("repo")
    expect(definition).toEqual({
      source: { directory: instanceDir, include: EXPECTED.map((path) => `repo/${path}`) },
      environmentLinks: [],
    })
    expect("baseline" in definition).toBe(false)
    const staged = join(appRoot, instanceDir)
    for (const path of EXPECTED) expect(existsSync(join(staged, "repo", path))).toBe(true)
    // The object store, not the working tree.
    expect(existsSync(join(staged, "repo/packages/cli/src/untracked.ts"))).toBe(false)
    // draft/ is the drafter's to create; nothing is staged at that name.
    expect(existsSync(join(staged, "repo/draft"))).toBe(false)
    expect(existsSync(join(staged, "draft"))).toBe(false)
    expect(definition.source.include.some((p) => p.includes("draft/"))).toBe(false)
    // The executable bit survives the archive and the extraction.
    expect(statSync(join(staged, "repo/scripts/run.sh")).mode & 0o111).not.toBe(0)
    expect(statSync(join(staged, "repo/scripts/check-docs.mjs")).mode & 0o111).toBe(0)
  })

  it("captures under the framework's limits, recording the executable bit", async () => {
    const { root, pin } = repo()
    const appRoot = mkdtempSync(join(tmpdir(), "factory-wide-app-"))
    dirs.push(appRoot)
    const instanceDir = ".factory/captures/drafter/wo-1.def"
    const captured = await captureWorkspaceDefinition(
      appRoot,
      stageWideCapture(root, pin, instanceDir, { appRoot }),
    )
    expect(captured.baseline).toBeUndefined()
    expect(captured.environmentLinks).toEqual([])
    expect(captured.source.files.map((f) => f.path)).toEqual(EXPECTED.map((path) => `repo/${path}`))
    const byPath = new Map(captured.source.files.map((f) => [f.path, f.executable]))
    expect(byPath.get("repo/scripts/run.sh")).toBe(true)
    expect(byPath.get("repo/scripts/check-docs.mjs")).toBe(false)
  })

  it("the live HEAD's wide capture fits the framework's capture limits", {
    timeout: 120_000,
  }, async () => {
    const root = repositoryRoot()
    const pin = git(root, "rev-parse", "HEAD")
    const appRoot = mkdtempSync(join(tmpdir(), "factory-wide-app-"))
    dirs.push(appRoot)
    const instanceDir = ".factory/captures/drafter/wo-live.ghi"
    const definition = stageWideCapture(root, pin, instanceDir, { appRoot })
    const captured = await captureWorkspaceDefinition(appRoot, definition)
    expect(captured.source.files.length).toBe(definition.source.include.length)
    const executables = captured.source.files.filter((f) => f.executable).map((f) => f.path)
    const modes = execFileSync("git", ["-C", root, "ls-tree", "-r", pin], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.startsWith("100755 "))
      .map((line) => `repo/${line.slice(line.indexOf("\t") + 1)}`)
      .filter((path) => definition.source.include.includes(path))
      .sort()
    expect(executables).toEqual(modes)
    expect(executables.length).toBeGreaterThan(0)
  })
})
