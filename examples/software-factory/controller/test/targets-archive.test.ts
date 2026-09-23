import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  ArchiveArgumentsError,
  archiveTreeInto,
  type CaptureRole,
  captureTarget,
  MAX_ARCHIVE_ARGV_BYTES,
} from "../src/lib/targets/archive.ts"
import type { Task } from "../src/lib/targets/catalog.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A repository with a subdirectory, an untracked file, a dirty working tree, a file deleted
 * from the working tree after the commit, and a committed file outside the include list.
 */
function repo(): { root: string; pin: string } {
  const root = mkdtempSync(join(tmpdir(), "factory-archive-repo-"))
  dirs.push(root)
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  mkdirSync(join(root, "pkg", "src"), { recursive: true })
  writeFileSync(join(root, "pkg", "src", "a.ts"), "export const a = 1\n")
  writeFileSync(join(root, "pkg", "package.json"), "{}\n")
  writeFileSync(join(root, "pkg", "NOTES.md"), "not in the include list\n")
  writeFileSync(join(root, "other.txt"), "other\n")
  git("add", ".")
  git("commit", "-q", "-m", "one")
  writeFileSync(join(root, "pkg", "src", "untracked.ts"), "not committed\n")
  writeFileSync(join(root, "pkg", "src", "a.ts"), "export const a = 2 // dirty working tree\n")
  const pin = git("rev-parse", "HEAD")
  // Deleted from the working tree after the commit: the archive must still find it at the pin.
  rmSync(join(root, "pkg", "package.json"))
  return { root, pin }
}

const defect = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-export const a = 1
+export const a = 0
`

function task(pin: string, overrides: Partial<Task> = {}): Task {
  return {
    id: "k",
    directory: "/unused",
    manifest: {
      id: "k",
      target: "t",
      allowedSourcePaths: ["src/a.ts"],
      immutablePaths: ["package.json"],
    },
    checks: {
      visible: { runner: "vitest", assertions: ["x"] },
      independent: { runner: "node-test", file: "checks/k.test.ts", assertions: ["x"] },
    },
    specText: "spec",
    defectPatch: null,
    referencePatch: "",
    target: {
      id: "t",
      directory: "/unused",
      pin,
      root: "pkg",
      capture: { include: ["src", "package.json"] },
      snapshotIgnore: [],
      image: {
        localId: `sha256:${"a".repeat(64)}`,
        platform: "linux/arm64",
        baseManifestDigest: `sha256:${"b".repeat(64)}`,
        dockerfileSha256: "c".repeat(64),
        lockfileSha256: "d".repeat(64),
        pnpmVersion: "10.33.0",
      },
      imageContext: ["package.json"],
      lockfile: "package.json",
      imageAssertResolves: [],
      environmentLinks: [{ path: "node_modules", target: "/opt/targets/t/node_modules" }],
      commands: { cwd: ".", build: [], test: ["x"], nodeTestExecArgv: [] },
      runnerConfig: ["package.json"],
      resources: { memoryMb: 1, cpus: 1, commandTimeoutMs: 1, verifierDeadlineMs: 1 },
    },
    ...overrides,
  }
}

describe("captureTarget", () => {
  it("archives the pinned subtree, not the working tree, into an app-relative directory", () => {
    const { root, pin } = repo()
    const captureRoot = mkdtempSync(join(tmpdir(), "factory-archive-app-"))
    dirs.push(captureRoot)
    const captured = captureTarget(task(pin), "controller", { captureRoot, repositoryRoot: root })
    expect(captured.directory).toBe("captures/controller/k")
    expect(captured.absolute).toBe(join(captureRoot, "captures", "controller", "k"))
    expect(readFileSync(join(captured.absolute, "src", "a.ts"), "utf8")).toBe(
      "export const a = 1\n",
    )
    expect(existsSync(join(captured.absolute, "src", "untracked.ts"))).toBe(false)
    expect(existsSync(join(captured.absolute, "other.txt"))).toBe(false)
    // Not in the include list, even though it was committed inside `pkg`: proves the include
    // list filters rather than just excluding paths outside `root`.
    expect(existsSync(join(captured.absolute, "NOTES.md"))).toBe(false)
    // Deleted from the working tree after the commit, but still at the pin.
    expect(readFileSync(join(captured.absolute, "package.json"), "utf8")).toBe("{}\n")
    expect(readdirSync(captured.absolute).sort()).toEqual(["package.json", "src"])
  })

  it("archives the whole repository when root is `.`", () => {
    const { root, pin } = repo()
    const captureRoot = mkdtempSync(join(tmpdir(), "factory-archive-app-"))
    dirs.push(captureRoot)
    const t = task(pin)
    const whole = {
      ...t,
      target: { ...t.target, root: "." as const, capture: { include: ["pkg", "other.txt"] } },
    }
    const captured = captureTarget(whole, "controller", { captureRoot, repositoryRoot: root })
    expect(readdirSync(captured.absolute).sort()).toEqual(["other.txt", "pkg"])
    expect(readFileSync(join(captured.absolute, "pkg", "src", "a.ts"), "utf8")).toBe(
      "export const a = 1\n",
    )
  })

  it("applies the defect patch, and rebuilds the directory on every capture", () => {
    const { root, pin } = repo()
    const captureRoot = mkdtempSync(join(tmpdir(), "factory-archive-app-"))
    dirs.push(captureRoot)
    const first = captureTarget(task(pin, { defectPatch: defect }), "builder", {
      captureRoot,
      repositoryRoot: root,
    })
    expect(readFileSync(join(first.absolute, "src", "a.ts"), "utf8")).toBe("export const a = 0\n")
    writeFileSync(join(first.absolute, "stray.txt"), "left behind\n")
    const second = captureTarget(task(pin, { defectPatch: defect }), "builder", {
      captureRoot,
      repositoryRoot: root,
    })
    expect(second.absolute).toBe(first.absolute)
    expect(existsSync(join(second.absolute, "stray.txt"))).toBe(false)
    // No scratch files survive beside the capture.
    expect(readdirSync(join(captureRoot, "captures", "builder"))).toEqual(["k"])
  })

  it("keeps the builder's and the controller's copies apart", () => {
    const { root, pin } = repo()
    const captureRoot = mkdtempSync(join(tmpdir(), "factory-archive-app-"))
    dirs.push(captureRoot)
    const builder = captureTarget(task(pin), "builder", { captureRoot, repositoryRoot: root })
    const controller = captureTarget(task(pin), "controller", {
      captureRoot,
      repositoryRoot: root,
    })
    expect(builder.absolute).not.toBe(controller.absolute)
  })

  it("throws when the defect patch does not apply, and when an include path is not at the pin", () => {
    const { root, pin } = repo()
    const captureRoot = mkdtempSync(join(tmpdir(), "factory-archive-app-"))
    dirs.push(captureRoot)
    const wrong = defect.replace("-export const a = 1", "-export const a = 9")
    expect(() =>
      captureTarget(task(pin, { defectPatch: wrong }), "builder", {
        captureRoot,
        repositoryRoot: root,
      }),
    ).toThrow(/defect patch/)
    const t = task(pin)
    const missing = { ...t, target: { ...t.target, capture: { include: ["nope"] } } }
    expect(() => captureTarget(missing, "builder", { captureRoot, repositoryRoot: root })).toThrow(
      /nope/,
    )
  })

  it("leaves nothing behind when a capture fails", () => {
    const { root, pin } = repo()
    const captureRoot = mkdtempSync(join(tmpdir(), "factory-archive-app-"))
    dirs.push(captureRoot)
    const wrong = defect.replace("-export const a = 1", "-export const a = 9")
    expect(() =>
      captureTarget(task(pin, { defectPatch: wrong }), "builder", {
        captureRoot,
        repositoryRoot: root,
      }),
    ).toThrow()
    const parent = join(captureRoot, "captures", "builder")
    expect(existsSync(join(parent, "k"))).toBe(false)
    // No scratch sibling either: whatever the parent directory holds, it isn't a leftover.
    if (existsSync(parent)) expect(readdirSync(parent)).toEqual([])
  })

  it("keeps two instances of the same role and task apart, and neither clobbers the other", () => {
    const { root, pin } = repo()
    const captureRoot = mkdtempSync(join(tmpdir(), "factory-archive-app-"))
    dirs.push(captureRoot)
    const one = captureTarget(task(pin), "controller", {
      captureRoot,
      repositoryRoot: root,
      instance: "one",
    })
    const two = captureTarget(task(pin), "controller", {
      captureRoot,
      repositoryRoot: root,
      instance: "two",
    })
    expect(one.directory).toBe("captures/controller/k.one")
    expect(two.directory).toBe("captures/controller/k.two")
    expect(one.absolute).not.toBe(two.absolute)
    writeFileSync(join(one.absolute, "stray.txt"), "only in one\n")
    expect(existsSync(join(one.absolute, "src", "a.ts"))).toBe(true)
    expect(existsSync(join(two.absolute, "src", "a.ts"))).toBe(true)
    expect(existsSync(join(two.absolute, "stray.txt"))).toBe(false)
  })

  it("refuses a role that is not a plain name", () => {
    const { root, pin } = repo()
    expect(() =>
      captureTarget(task(pin), "../x" as CaptureRole, { captureRoot: root, repositoryRoot: root }),
    ).toThrow(/role/)
  })
})

describe("archiveTreeInto", () => {
  it("extracts an explicit file list under a prefix, keeping the executable bit", () => {
    const { root, pin } = repo()
    execFileSync("git", ["-C", root, "update-index", "--chmod=+x", "pkg/src/a.ts"])
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "exec"])
    const exec = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    expect(exec).not.toBe(pin)
    const destination = mkdtempSync(join(tmpdir(), "factory-archive-dest-"))
    dirs.push(destination)
    archiveTreeInto(root, exec, ["pkg/src/a.ts", "pkg/package.json"], destination, {
      prefix: "repo/",
      label: "t",
    })
    expect(readdirSync(destination).sort()).toEqual(["repo"])
    expect(readdirSync(join(destination, "repo", "pkg")).sort()).toEqual(["package.json", "src"])
    expect(statSync(join(destination, "repo/pkg/src/a.ts")).mode & 0o111).not.toBe(0)
    expect(statSync(join(destination, "repo/pkg/package.json")).mode & 0o111).toBe(0)
  })

  it("refuses an include list too large for one command line, before invoking git", () => {
    const destination = mkdtempSync(join(tmpdir(), "factory-archive-dest-"))
    dirs.push(destination)
    const include = Array.from({ length: 6_000 }, (_, i) => `p/${"x".repeat(96)}/${i}.ts`)
    expect(include.join(" ").length).toBeGreaterThan(MAX_ARCHIVE_ARGV_BYTES)
    expect(() =>
      archiveTreeInto("/nonexistent", "0".repeat(40), include, destination, { label: "t" }),
    ).toThrow(ArchiveArgumentsError)
    expect(readdirSync(destination)).toEqual([])
  })
})
