import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { isFactoryImage } from "../src/lib/builder-handoff.ts"
import { type Task, tagFor } from "../src/lib/targets/catalog.ts"
import {
  drafterInspectionOptions,
  targetInspectionOptions,
  targetSandboxPolicy,
  targetWorkspace,
} from "../src/lib/targets/workspace.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A repository with a subdirectory holding one committed source file and a package.json. */
function repo(): { root: string; pin: string } {
  const root = mkdtempSync(join(tmpdir(), "factory-ws-repo-"))
  dirs.push(root)
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  mkdirSync(join(root, "pkg", "src"), { recursive: true })
  writeFileSync(join(root, "pkg", "src", "a.ts"), "export const a = 1\n")
  writeFileSync(join(root, "pkg", "package.json"), "{}\n")
  git("add", ".")
  git("commit", "-q", "-m", "one")
  const pin = git("rev-parse", "HEAD")
  return { root, pin }
}

/** Like {@link repo}, but the pinned subtree itself carries a file the workspace reserves. */
function repoWithReservedFile(name: string): { root: string; pin: string } {
  const root = mkdtempSync(join(tmpdir(), "factory-ws-repo-"))
  dirs.push(root)
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  mkdirSync(join(root, "pkg", "src"), { recursive: true })
  writeFileSync(join(root, "pkg", "src", "a.ts"), "export const a = 1\n")
  writeFileSync(join(root, "pkg", "package.json"), "{}\n")
  writeFileSync(join(root, "pkg", name), "reserved\n")
  git("add", ".")
  git("commit", "-q", "-m", "one")
  const pin = git("rev-parse", "HEAD")
  return { root, pin }
}

function task(pin: string): Task {
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
    specText: "# spec\n",
    defectPatch: null,
    referencePatch: "",
    target: {
      id: "t",
      directory: "/unused",
      pin,
      root: "pkg",
      capture: { include: ["src", "package.json"] },
      snapshotIgnore: ["packages/x/dist/"],
      baseImage: `node:24-slim@sha256:${"e".repeat(64)}`,
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
      resources: {
        memoryMb: 2048,
        cpus: 2,
        commandTimeoutMs: 300_000,
        verifierDeadlineMs: 600_000,
      },
    },
  }
}

describe("targetWorkspace", () => {
  it("captures from the role's archive with the task spec as TASK.md and one root link", () => {
    const { root, pin } = repo()
    const captureRoot = mkdtempSync(join(tmpdir(), "factory-ws-app-"))
    dirs.push(captureRoot)
    const t = task(pin)
    const definition = targetWorkspace(t, "controller", { captureRoot, repositoryRoot: root })
    expect(definition.source.directory).toBe("captures/controller/k")
    expect(existsSync(join(captureRoot, "captures", "controller", "k", "src", "a.ts"))).toBe(true)
    // Flat, sorted, and derived from what the archive actually extracted — not restating the
    // target's own directory-shaped `capture.include`.
    expect(definition.source.include).toEqual(["package.json", "src/a.ts"])
    expect(definition.source.files).toEqual([
      { path: "TASK.md", text: "# spec\n" },
      { path: ".gitignore", text: "node_modules/\npackages/x/dist/\n" },
    ])
    expect(definition.environmentLinks).toEqual([
      { path: "node_modules", target: "/opt/targets/t/node_modules" },
    ])
    expect(definition.baseline).toBe("git")
  })

  it("refuses a capture that carries the reserved TASK.md or .gitignore names", () => {
    const captureRoot = mkdtempSync(join(tmpdir(), "factory-ws-app-"))
    dirs.push(captureRoot)
    for (const name of ["TASK.md", ".gitignore"]) {
      const { root, pin } = repoWithReservedFile(name)
      const t = task(pin)
      const withReserved = {
        ...t,
        target: { ...t.target, capture: { include: ["src", "package.json", name] } },
      }
      expect(() =>
        targetWorkspace(withReserved, "controller", { captureRoot, repositoryRoot: root }),
      ).toThrow(new RegExp(`must not contain ${name.replace(".", "\\.")}; it is reserved`))
    }
  })
})

describe("targetInspectionOptions", () => {
  it("derives the root symlinks and the git exclusion from the target, without restating the reader's limits", () => {
    const options = targetInspectionOptions(task("0".repeat(40)))
    expect(options.excludeRootDirectories).toEqual([".git"])
    expect(options.expectedRootSymlinks).toEqual({ node_modules: "/opt/targets/t/node_modules" })
    // The same prefixes the verifier's tamper comparison skips: a builder that runs the
    // target's build writes there, and the assembly rule rejects any path the baseline lacks.
    expect(options.ignorePrefixes).toEqual(task("0".repeat(40)).target.snapshotIgnore)
    expect(options).not.toHaveProperty("maxEntries")
    expect(options).not.toHaveProperty("maxFileBytes")
    expect(options).not.toHaveProperty("maxTotalBytes")
  })
})

describe("targetSandboxPolicy", () => {
  it("denies the network and takes resources from the target", () => {
    const policy = targetSandboxPolicy(task("0".repeat(40)).target)
    expect(policy.network?.mode).toBe("deny")
    expect(policy.resources).toEqual({ memoryMb: 2048, cpus: 2, timeoutMs: 300_000 })
    expect(policy.env).toEqual({
      npm_config_cache: "/tmp/npm-cache",
      npm_config_update_notifier: "false",
    })
  })
})

describe("the factory's images", () => {
  it("are every one an image the builder's provider allows", () => {
    const { target } = task("0".repeat(40))
    expect(isFactoryImage(tagFor(target.id, target.pin, "c".repeat(64)))).toBe(true)
    expect(isFactoryImage("alpine:latest")).toBe(false)
  })
})

describe("the drafter's inspection", () => {
  it("inspects a draft as a handful of small text files with no links and no baseline", () => {
    expect(drafterInspectionOptions()).toEqual({
      excludeRootDirectories: [],
      expectedRootSymlinks: {},
      maxEntries: 200,
      maxFileBytes: 512 * 1024,
      maxTotalBytes: 2 * 1024 * 1024,
    })
  })
})
