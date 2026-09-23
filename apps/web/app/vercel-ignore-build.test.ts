import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SCRIPT = join(WEB_ROOT, "scripts/vercel-ignore-build.sh")
const SKIP = 0
const BUILD = 1

const repos: string[] = []
afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true })
})

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

function commit(repo: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", `change ${Object.keys(files).join(" ")}`)
  return git(repo, "rev-parse", "HEAD")
}

function monorepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "b4-vercel-ignore-"))
  repos.push(repo)
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "test@example.com")
  git(repo, "config", "user.name", "Test")
  mkdirSync(join(repo, "apps/web/scripts"), { recursive: true })
  copyFileSync(SCRIPT, join(repo, "apps/web/scripts/vercel-ignore-build.sh"))
  commit(repo, {
    "apps/web/page.tsx": "v1",
    "packages/sdk/index.ts": "v1",
    "pnpm-lock.yaml": "v1",
    "docs/notes.md": "v1",
    "examples/chat/index.ts": "v1",
  })
  return repo
}

// Vercel runs the ignore command from the project's root directory (apps/web).
function decide(repo: string, env: Record<string, string> = {}): number | null {
  const result = spawnSync("bash", ["scripts/vercel-ignore-build.sh"], {
    cwd: join(repo, "apps/web"),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_ENV: "test",
      VERCEL_ENV: "preview",
      ...env,
    },
  })
  return result.status
}

describe("website Vercel ignore-build step", () => {
  it("is the configured ignore command", () => {
    const config = JSON.parse(readFileSync(join(WEB_ROOT, "vercel.json"), "utf8"))
    expect(config.ignoreCommand).toBe("bash scripts/vercel-ignore-build.sh")
  })

  it("always builds production", () => {
    const repo = monorepo()
    commit(repo, { "docs/notes.md": "v2" })
    expect(decide(repo, { VERCEL_ENV: "production" })).toBe(BUILD)
  })

  it("skips a preview when only files outside the site's inputs changed", () => {
    const repo = monorepo()
    commit(repo, { "docs/notes.md": "v2", "examples/chat/index.ts": "v2" })
    expect(decide(repo)).toBe(SKIP)
  })

  it.each([
    ["the site itself", "apps/web/page.tsx"],
    ["a workspace package", "packages/sdk/index.ts"],
    ["the lockfile", "pnpm-lock.yaml"],
    ["root workspace config", "turbo.json"],
  ])("builds a preview when %s changed", (_label, path) => {
    const repo = monorepo()
    commit(repo, { [path]: "v2" })
    expect(decide(repo)).toBe(BUILD)
  })

  it("compares against the previously deployed commit, not just the parent", () => {
    const repo = monorepo()
    const deployed = git(repo, "rev-parse", "HEAD")
    commit(repo, { "apps/web/page.tsx": "v2" })
    commit(repo, { "docs/notes.md": "v2" })
    // HEAD^ alone would skip; the push since the last deploy touched the site.
    expect(decide(repo)).toBe(SKIP)
    expect(decide(repo, { VERCEL_GIT_PREVIOUS_SHA: deployed })).toBe(BUILD)
  })

  it("falls back to the parent commit when the previous SHA is not in the clone", () => {
    const repo = monorepo()
    commit(repo, { "docs/notes.md": "v2" })
    expect(decide(repo, { VERCEL_GIT_PREVIOUS_SHA: "0".repeat(40) })).toBe(SKIP)
    commit(repo, { "apps/web/page.tsx": "v3" })
    expect(decide(repo, { VERCEL_GIT_PREVIOUS_SHA: "0".repeat(40) })).toBe(BUILD)
  })

  it("builds when there is no commit to compare against", () => {
    const repo = monorepo()
    expect(decide(repo)).toBe(BUILD)
  })
})
