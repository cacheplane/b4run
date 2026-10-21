import { execFile } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  adopt,
  adoptCommitMessage,
  biomeIn,
  changesetFor,
  issueTitleFrom,
  promoteCheck,
} from "../src/lib/operator/adopt.ts"

/** This repository: the checkout whose Biome and config `adopt` would find. */
const repositoryRoot = join(import.meta.dirname, "..", "..", "..", "..")

const run = promisify(execFile)

/** The independent check the second live run drafted for #1053, verbatim. */
const CHECK = `import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"

const { writeTemplate } = await import(join(process.cwd(), "packages/devkit/dist/write-template.js"))
const dirs: string[] = []
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => {})
})

test("A1: writeTemplate writes replacement values containing $$ exactly as given", async () => {
  const target = await mkdtemp(join(tmpdir(), "check-"))
  dirs.push(target)
  await writeTemplate({ templateDir: target, targetDir: target, replacements: { appName: "my$$app" } })
  const content = await readFile(join(target, "package.json"), "utf8")
  assert.equal(content, '{"name":"my$$app"}')
})
`

describe("issueTitleFrom", () => {
  it("reads the title off issue.md's heading, without the repository suffix intake appends", () => {
    const md = "# devkit: writeTemplate mangles `$` (cacheplane/b4run#1053)\n\n## What happens\n"
    expect(issueTitleFrom(md, "cacheplane/b4run", 1053)).toBe("devkit: writeTemplate mangles `$`")
    expect(issueTitleFrom("# plain", "o/r", 1)).toBe("plain")
  })
})

describe("changesetFor", () => {
  it("writes a patch for the package under .changeset/factory-<id>.md, naming the issue", () => {
    expect(
      changesetFor({
        workOrderId: "wo-1",
        packageName: "@b4run/devkit",
        title: "writeTemplate  mangles\n$",
        issueNumber: 1053,
      }),
    ).toEqual({
      path: ".changeset/factory-wo-1.md",
      text: '---\n"@b4run/devkit": patch\n---\n\nwriteTemplate mangles $. Refs #1053.\n',
    })
  })
})

describe("promoteCheck", () => {
  it("turns the drafted node:test check into the package's own vitest file", () => {
    const promoted = promoteCheck({
      packageDir: "packages/devkit",
      checkFile: "checks/write-template.test.ts",
      source: CHECK,
    })
    expect(promoted).toMatchObject({
      ok: true,
      path: "packages/devkit/test/write-template.test.ts",
    })
    if (!promoted.ok) throw new Error(promoted.reason)
    const lines = promoted.source.split("\n")
    expect(lines[0]).toBe('import { afterAll, test } from "vitest"')
    expect(lines[1]).toBe('import { writeTemplate } from "../src/write-template.ts"')
    expect(promoted.source).not.toContain("node:test")
    expect(promoted.source).not.toContain("process.cwd()")
    expect(promoted.source).not.toContain("dist/")
    expect(promoted.source).toContain("afterAll(async () => {")
    expect(promoted.source).toContain('test("A1: writeTemplate writes replacement values')
    // `join` is still used by the test body, so its import stays.
    expect(promoted.source).toContain('import { join } from "node:path"')
    // Nothing else moved: the assertion is the drafted one.
    expect(promoted.source).toContain(`assert.equal(content, '{"name":"my$$app"}')`)
  })

  it("binds a whole module when the check kept it under one name, and drops an unused join", () => {
    const promoted = promoteCheck({
      packageDir: "packages/cli",
      checkFile: "checks/port.test.ts",
      source: [
        'import { join } from "node:path"',
        'import test from "node:test"',
        'import assert from "node:assert/strict"',
        'const ports = await import(join(process.cwd(), "packages/cli/dist/lib/dev/parse-port.js"))',
        'test("A1: x", () => assert.equal(ports.parsePort("1"), 1))',
        "",
      ].join("\n"),
    })
    if (!promoted.ok) throw new Error(promoted.reason)
    expect(promoted.path).toBe("packages/cli/test/port.test.ts")
    expect(promoted.source).toBe(
      [
        'import { test } from "vitest"',
        'import * as ports from "../src/lib/dev/parse-port.ts"',
        'import assert from "node:assert/strict"',
        "",
        'test("A1: x", () => assert.equal(ports.parsePort("1"), 1))',
        "",
      ].join("\n"),
    )
  })

  it("refuses what it cannot express, with the reason", () => {
    const reason = (source: string, packageDir = "packages/devkit") => {
      const result = promoteCheck({ packageDir, checkFile: "checks/x.test.ts", source })
      return result.ok ? "ok" : result.reason
    }
    expect(reason(CHECK, ".")).toMatch(/repository root/)
    expect(reason(CHECK.replace("{ after, test }", "{ after, test, mock }"))).toMatch(
      /`mock` has no vitest form/,
    )
    expect(reason(CHECK.replace("{ after, test }", "{ after, test as t }"))).toMatch(/aliased/)
    expect(reason(CHECK.replace('from "node:test"', 'from "vitest"'))).toMatch(
      /does not import node:test/,
    )
    expect(
      reason(CHECK.replace("await import(join(process.cwd(), ", "require(join(process.cwd(), ")),
    ).toMatch(/no `await import/)
    expect(reason(`${CHECK}\nconst root = process.cwd()\n`)).toMatch(/process\.cwd\(\)/)
    expect(reason(`${CHECK}\nconst other = "packages/devkit/dist/x.js"\n`)).toMatch(/dist\/ path/)
  })
})

describe("biomeIn and the promoted test's formatting", () => {
  it("finds this checkout's Biome and config, and none in a bare directory", () => {
    expect(biomeIn(repositoryRoot)).toEqual({
      binary: join(repositoryRoot, "node_modules", ".bin", "biome"),
      config: join(repositoryRoot, "packages", "config-biome", "biome.json"),
    })
    const bare = mkdtempSync(join(tmpdir(), "factory-adopt-bare-"))
    try {
      expect(biomeIn(bare)).toBeUndefined()
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it("leaves the promoted check lint-clean under the checkout's own Biome once formatted, as adopt formats it", async () => {
    // The translation alone is not: Biome orders imports and wraps the long test names. The
    // second live run's hand-off needed a formatting commit for exactly this.
    const biome = biomeIn(repositoryRoot)
    if (!biome) throw new Error("this checkout has no Biome")
    const promoted = promoteCheck({
      packageDir: "packages/devkit",
      checkFile: "checks/write-template.test.ts",
      source: CHECK,
    })
    if (!promoted.ok) throw new Error(promoted.reason)
    const dir = mkdtempSync(join(tmpdir(), "factory-adopt-format-"))
    try {
      mkdirSync(join(dir, "packages", "devkit", "test"), { recursive: true })
      writeFileSync(join(dir, promoted.path), promoted.source)
      const check = () =>
        run(biome.binary, ["check", "--config-path", biome.config, promoted.path], { cwd: dir })
      await expect(check()).rejects.toThrow()
      await run(biome.binary, ["check", "--write", "--config-path", biome.config, promoted.path], {
        cwd: dir,
      })
      await expect(check()).resolves.toBeTruthy()
      expect(readFileSync(join(dir, promoted.path), "utf8")).toContain(
        'import { writeTemplate } from "../src/write-template.ts"',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe("adoptCommitMessage", () => {
  it("names the issue, the factory PR, the work order, and what the adopter added", () => {
    expect(
      adoptCommitMessage({
        title: "fix it",
        issueNumber: 7,
        factoryPullRequest: 9,
        workOrderId: "wo-1",
        changeset: ".changeset/factory-wo-1.md",
        promoted: "packages/devkit/test/x.test.ts",
      }),
    ).toBe(
      "fix it (#7)\n\nAdopted from the factory's draft PR #9 (work order wo-1): the delivered commit, cherry-picked, plus a changeset (.changeset/factory-wo-1.md) and the factory's independent check as packages/devkit/test/x.test.ts.\n\nCloses #7",
    )
    expect(
      adoptCommitMessage({
        title: "t",
        issueNumber: 1,
        factoryPullRequest: 2,
        workOrderId: "wo-2",
        changeset: null,
        promoted: null,
      }),
    ).toContain("the delivered commit, cherry-picked.\n")
  })
})

describe("adopt against a real git repository and a stubbed gh", () => {
  const dirs: string[] = []
  // `adopt` commits with the person's own git identity (the environment's); here that is the
  // test's, so the adopter's commit is attributable and the author assertion below holds.
  const identity = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "adopter",
    GIT_AUTHOR_EMAIL: "adopter@example.test",
    GIT_COMMITTER_NAME: "adopter",
    GIT_COMMITTER_EMAIL: "adopter@example.test",
  }
  const previous: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const [key, value] of Object.entries(identity)) {
      previous[key] = process.env[key]
      process.env[key] = value
    }
  })
  afterEach(() => {
    for (const key of Object.keys(identity)) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "adopter",
    GIT_AUTHOR_EMAIL: "adopter@example.test",
    GIT_COMMITTER_NAME: "adopter",
    GIT_COMMITTER_EMAIL: "adopter@example.test",
  }
  const git = (cwd: string, ...args: string[]) => run("git", ["-C", cwd, ...args], { env: gitEnv })

  /**
   * A bare origin with `main` (a devkit package and its defect) and `factory/wo-1` (the app's
   * one-commit fix on top of main's tip), and a clone that stands in for FACTORY_REPO_ROOT.
   */
  async function repositories() {
    const base = mkdtempSync(join(tmpdir(), "factory-adopt-"))
    dirs.push(base)
    const origin = join(base, "origin.git")
    const seed = join(base, "seed")
    await run("git", ["init", "--bare", "-q", "-b", "main", origin], { env: gitEnv })
    await run("git", ["init", "-q", "-b", "main", seed], { env: gitEnv })
    mkdirSync(join(seed, "packages", "devkit", "src"), { recursive: true })
    mkdirSync(join(seed, ".changeset"), { recursive: true })
    writeFileSync(join(seed, ".changeset", "README.md"), "changesets\n")
    writeFileSync(
      join(seed, "packages", "devkit", "package.json"),
      JSON.stringify({ name: "@b4run/devkit", version: "0.0.1" }),
    )
    writeFileSync(
      join(seed, "packages", "devkit", "src", "write-template.ts"),
      "export const v = 1\n",
    )
    await git(seed, "add", ".")
    await git(seed, "commit", "-q", "-m", "init")
    const factory = join(base, "factory")
    await git(seed, "worktree", "add", "-q", "-b", "factory/wo-1", factory)
    writeFileSync(
      join(factory, "packages", "devkit", "src", "write-template.ts"),
      "export const v = 2\n",
    )
    await git(factory, "add", ".")
    await run("git", ["-C", factory, "commit", "-q", "-m", "factory: fix"], {
      env: {
        ...gitEnv,
        GIT_AUTHOR_NAME: "b4dotrun[bot]",
        GIT_AUTHOR_EMAIL: "bot@example.test",
        GIT_COMMITTER_NAME: "b4dotrun[bot]",
        GIT_COMMITTER_EMAIL: "bot@example.test",
      },
    })
    const headSha = (await git(factory, "rev-parse", "HEAD")).stdout.trim()
    await git(seed, "remote", "add", "origin", origin)
    await git(seed, "push", "-q", "origin", "main", "factory/wo-1")
    const root = join(base, "checkout")
    await run("git", ["clone", "-q", origin, root], { env: gitEnv })
    // The stub gh: records every call, answers `pr create` with a URL.
    const log = join(base, "gh.log")
    const gh = join(base, "gh")
    writeFileSync(
      gh,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$1 $2" in "pr create") echo "https://github.com/o/r/pull/42";; esac\n`,
    )
    chmodSync(gh, 0o755)
    return { origin, root, headSha, gh, log }
  }

  const input = (root: string, headSha: string, extra: Record<string, unknown> = {}) => ({
    workOrderId: "wo-1",
    repository: "o/r",
    baseBranch: "main",
    factoryBranch: "factory/wo-1",
    headSha,
    factoryPullRequest: { number: 9, url: "https://github.com/o/r/pull/9" },
    issue: { number: 7, title: "devkit: fix it" },
    packageDir: "packages/devkit",
    check: { file: "checks/write-template.test.ts", source: CHECK },
    bundleDigest: "b".repeat(64),
    receiptId: "rc-1",
    verifierIdentity: "docker:abc",
    repositoryRoot: root,
    openPullRequest: true,
    closeFactoryPullRequest: true,
    ...extra,
  })

  it("cherry-picks the delivered commit, adds the changeset and the promoted test, pushes, opens the PR, and closes the draft", async () => {
    const { origin, root, headSha, gh, log } = await repositories()
    const before = (await git(root, "status", "--porcelain", "--branch")).stdout
    const result = await adopt(input(root, headSha), { gh })
    expect(result).toMatchObject({
      ok: true,
      branch: "adopt/wo-1",
      changeset: ".changeset/factory-wo-1.md",
      // The fixture checkout has no Biome: the translation is committed as is, and says so.
      promoted: { path: "packages/devkit/test/write-template.test.ts", formatted: false },
      pullRequest: { url: "https://github.com/o/r/pull/42" },
      factoryPullRequest: { number: 9, closed: true },
    })
    // The checkout's own branch and working tree are untouched, and no worktree is left.
    expect((await git(root, "status", "--porcelain", "--branch")).stdout).toBe(before)
    expect((await git(root, "worktree", "list")).stdout.trim().split("\n")).toHaveLength(1)
    // On origin: the factory's commit first (its author the app), the adopter's on top.
    const log2 = (
      await git(root, "log", "--format=%an|%s", "origin/main..origin/adopt/wo-1")
    ).stdout
      .trim()
      .split("\n")
    expect(log2).toEqual(["adopter|devkit: fix it (#7)", "b4dotrun[bot]|factory: fix"])
    expect((await git(root, "rev-parse", "origin/adopt/wo-1")).stdout.trim()).toBe(result.commit)
    const show = (path: string) =>
      run("git", ["-C", root, "show", `origin/adopt/wo-1:${path}`], { env: gitEnv }).then(
        (r) => r.stdout,
      )
    expect(await show(".changeset/factory-wo-1.md")).toBe(
      '---\n"@b4run/devkit": patch\n---\n\ndevkit: fix it. Refs #7.\n',
    )
    expect(await show("packages/devkit/test/write-template.test.ts")).toContain(
      'import { writeTemplate } from "../src/write-template.ts"',
    )
    expect(await show("packages/devkit/src/write-template.ts")).toBe("export const v = 2\n")
    const calls = readFileSync(log, "utf8").trim().split("\n")
    expect(calls[0]).toMatch(
      /^pr create --repo o\/r --base main --head adopt\/wo-1 --title devkit: fix it \(#7\) --body-file /,
    )
    expect(calls[1]).toMatch(
      /^pr comment 9 --repo o\/r --body Adopted as https:\/\/github.com\/o\/r\/pull\/42/,
    )
    expect(calls[2]).toBe("pr close 9 --repo o/r")
    expect(origin).toBeTruthy()
  }, 60_000)

  it("stops at the pushed branch with --no-pr, skips the changeset for a private package, and refuses an existing branch", async () => {
    const { root, headSha, gh, log } = await repositories()
    const result = await adopt(input(root, headSha, { openPullRequest: false, branch: "mine/x" }), {
      gh,
    })
    expect(result).toMatchObject({
      ok: true,
      branch: "mine/x",
      pullRequest: null,
      factoryPullRequest: { closed: false },
    })
    expect(() => readFileSync(log, "utf8")).toThrow()
    expect((await git(root, "rev-parse", "--verify", "origin/mine/x")).stdout.trim()).toHaveLength(
      40,
    )
    await expect(
      adopt(input(root, headSha, { openPullRequest: false, branch: "mine/x" }), { gh }),
    ).rejects.toThrow(/already exists/)
    await expect(adopt(input(root, headSha, { branch: "factory/other" }), { gh })).rejects.toThrow(
      /Refusing branch/,
    )
  }, 60_000)
})
