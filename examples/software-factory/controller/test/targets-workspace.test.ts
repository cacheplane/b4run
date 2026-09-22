import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { imageTag, type Task } from "../src/lib/targets/catalog.ts"
import {
  builderSandboxProvider,
  builderSandboxScope,
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
    const appRoot = mkdtempSync(join(tmpdir(), "factory-ws-app-"))
    dirs.push(appRoot)
    const t = task(pin)
    const definition = targetWorkspace(t, "controller", { appRoot, repositoryRoot: root })
    expect(definition.source.directory).toBe(".factory/captures/controller/k")
    expect(
      existsSync(join(appRoot, ".factory", "captures", "controller", "k", "src", "a.ts")),
    ).toBe(true)
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
    const appRoot = mkdtempSync(join(tmpdir(), "factory-ws-app-"))
    dirs.push(appRoot)
    for (const name of ["TASK.md", ".gitignore"]) {
      const { root, pin } = repoWithReservedFile(name)
      const t = task(pin)
      const withReserved = {
        ...t,
        target: { ...t.target, capture: { include: ["src", "package.json", name] } },
      }
      expect(() =>
        targetWorkspace(withReserved, "controller", { appRoot, repositoryRoot: root }),
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

describe("builderSandboxProvider", () => {
  it("is a docker provider on the target's derived image tag and the builder scope", () => {
    const t = task("0".repeat(40))
    const provider = builderSandboxProvider(t.target)
    expect(provider.name).toBe("docker")
    expect(imageTag(t.target)).toMatch(/^b4-factory-t:[a-f0-9]{12}-[a-f0-9]{12}$/)
    expect(builderSandboxScope).toBe("software-factory-builder")
  })
})
