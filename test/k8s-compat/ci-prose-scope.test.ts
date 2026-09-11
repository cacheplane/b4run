import { execFileSync, spawnSync } from "node:child_process"
import {
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
import { dirname, resolve } from "node:path"

import { describe, expect, test } from "vitest"
import { parse } from "yaml"
import type { GitCommandRunner, MetadataOnlyScopeRequest } from "../../scripts/ci-scope.mjs"
import * as scopeModule from "../../scripts/ci-scope.mjs"

const root = resolve(__dirname, "../..")
const workflow = parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"))
const prose = "docs/superpowers/runbooks/release.md"
const classify = (request: MetadataOnlyScopeRequest, runner: GitCommandRunner) =>
  (
    scopeModule as typeof scopeModule & {
      classifyProseOnlyScope: typeof scopeModule.classifyMetadataOnlyScope
    }
  ).classifyProseOnlyScope(request, runner)

function repository() {
  const directory = mkdtempSync(resolve(tmpdir(), "b4-prose-scope-"))
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  const write = (file: string, contents = "Runbook notes.\n") => {
    mkdirSync(dirname(resolve(directory, file)), { recursive: true })
    writeFileSync(resolve(directory, file), contents)
  }
  git("init", "--initial-branch=main")
  git("config", "user.name", "CI Scope Test")
  git("config", "user.email", "ci-scope@example.invalid")
  write("README.md", "Fixture\n")
  write(prose)
  git("add", ".")
  git("commit", "-m", "baseline")
  const commit = () => {
    git("add", "-A")
    git("commit", "--allow-empty", "-m", "fixture change")
    return git("rev-parse", "HEAD")
  }
  const runner: GitCommandRunner = async (file, args) => ({
    stdout: execFileSync(file, [...args], {
      cwd: directory,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  })
  return {
    directory,
    git,
    write,
    commit,
    runner,
    close: () => rmSync(directory, { recursive: true, force: true }),
  }
}

describe("prose-only runbook scope", () => {
  test.each(["edit", "add", "delete", "rename"])(
    "accepts regular Markdown %s changes",
    async (operation) => {
      const repo = repository()
      try {
        const base = repo.git("rev-parse", "HEAD")
        if (operation === "edit") repo.write(prose, "Updated notes.\n")
        if (operation === "add") repo.write("docs/superpowers/runbooks/nested/new.md")
        if (operation === "delete") repo.git("rm", prose)
        if (operation === "rename") repo.git("mv", prose, "docs/superpowers/runbooks/renamed.md")
        const head = repo.commit()
        expect(await classify({ event: "pull_request", base, head }, repo.runner)).toBe(true)
      } finally {
        repo.close()
      }
    },
  )

  test.each([
    "README.md",
    "packages/sdk/src/index.ts",
    "pnpm-lock.yaml",
    ".github/workflows/ci.yml",
    "apps/web/content/docs/intro.mdx",
    "docs/superpowers/plans/plan.md",
    "docs/superpowers/runbooks/script.mjs",
    "docs/superpowers/runbooks/data.json",
  ])("keeps full coverage when %s changes", async (file) => {
    const repo = repository()
    try {
      const base = repo.git("rev-parse", "HEAD")
      repo.write(prose, "Updated notes.\n")
      repo.write(file, "Changed\n")
      expect(
        await classify({ event: "pull_request", base, head: repo.commit() }, repo.runner),
      ).toBe(false)
    } finally {
      repo.close()
    }
  })

  test.each(["into", "out"])("does not hide renames %s the prose directory", async (direction) => {
    const repo = repository()
    try {
      const base = repo.git("rev-parse", "HEAD")
      if (direction === "into")
        repo.git("mv", "README.md", "docs/superpowers/runbooks/from-source.md")
      else repo.git("mv", prose, "elsewhere.md")
      expect(
        await classify({ event: "pull_request", base, head: repo.commit() }, repo.runner),
      ).toBe(false)
    } finally {
      repo.close()
    }
  })

  test.each(["executable-add", "executable-remove", "symlink-add", "symlink-remove"])(
    "rejects non-prose file modes: %s",
    async (mode) => {
      const repo = repository()
      try {
        const setMode = () => {
          if (mode.startsWith("executable")) repo.git("update-index", "--chmod=+x", prose)
          else {
            rmSync(resolve(repo.directory, prose))
            symlinkSync("../../../README.md", resolve(repo.directory, prose))
            repo.git("add", prose)
          }
        }
        if (mode.endsWith("remove")) {
          setMode()
          repo.git("commit", "-m", "nonregular baseline")
        }
        const base = repo.git("rev-parse", "HEAD")
        if (mode.endsWith("add")) setMode()
        else if (mode.startsWith("executable")) repo.git("update-index", "--chmod=-x", prose)
        else {
          rmSync(resolve(repo.directory, prose))
          repo.write(prose)
          repo.git("add", prose)
        }
        repo.git("commit", "-m", "mode change")
        expect(
          await classify(
            { event: "pull_request", base, head: repo.git("rev-parse", "HEAD") },
            repo.runner,
          ),
        ).toBe(false)
      } finally {
        repo.close()
      }
    },
  )

  test("does not treat an empty diff as prose", async () => {
    const repo = repository()
    try {
      const head = repo.git("rev-parse", "HEAD")
      expect(await classify({ event: "pull_request", base: head, head }, repo.runner)).toBe(false)
    } finally {
      repo.close()
    }
  })

  test("checks prose whitespace against the exact PR diff", async () => {
    const repo = repository()
    try {
      const base = repo.git("rev-parse", "HEAD")
      repo.write(prose, "Trailing whitespace   \n")
      await expect(
        classify({ event: "pull_request", base, head: repo.commit() }, repo.runner),
      ).rejects.toThrow()
    } finally {
      repo.close()
    }
  })

  test("retains full push validation without calling Git", async () => {
    expect(
      await classify({ event: "push" }, async () => {
        throw new Error("unexpected Git")
      }),
    ).toBe(false)
  })

  test.each([
    Buffer.from("not-nul-terminated"),
    Buffer.from("\0"),
    Buffer.from([255, 0]),
    Buffer.from(`:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0${prose}\0extra\0`),
  ])("rejects malformed raw diffs: %#", async (stdout) => {
    await expect(
      classify(
        { event: "pull_request", base: "a".repeat(40), head: "b".repeat(40) },
        async (_file, args) => ({ stdout: args[0] === "diff" ? stdout : Buffer.alloc(0) }),
      ),
    ).rejects.toThrow()
  })
})

describe("prose workflow routing", () => {
  test("the existing classifier exposes a separate prose result and validates it", () => {
    expect(workflow.jobs.metadata_scope.outputs.prose_only).toBe(
      `\${{ steps.classify.outputs.prose_only }}`,
    )
    const command = workflow.jobs.metadata_scope.steps.find(
      (s: { id?: string }) => s.id === "classify",
    ).run
    expect(command).toContain("scope.classifyProseOnlyScope")
    expect(command).toContain("Malformed prose-only scope output")
  })

  test("keeps the stable validation gate and fails closed on wrong or missing routing evidence", () => {
    const gate = workflow.jobs.validate
    expect(gate.if).toBe("always()")
    expect(gate.needs).toContain("metadata_scope")
    const step = gate.steps[0]
    const run = (env: Record<string, string>) =>
      spawnSync("/bin/sh", ["-c", step.run], {
        env: { PATH: process.env.PATH, ...env },
        encoding: "utf8",
        timeout: 5000,
      }).status
    const full = {
      EVENT_NAME: "pull_request",
      SCOPE_RESULT: "success",
      PROSE_ONLY: "false",
      METADATA_ONLY: "false",
      LANE_0: "success",
      LANE_1: "success",
      LANE_2: "success",
      LANE_3: "success",
    }
    const light = {
      ...full,
      PROSE_ONLY: "true",
      LANE_0: "skipped",
      LANE_1: "skipped",
      LANE_2: "skipped",
      LANE_3: "skipped",
    }
    expect(run(full)).toBe(0)
    expect(run(light)).toBe(0)
    expect(
      run({
        ...full,
        EVENT_NAME: "push",
        SCOPE_RESULT: "skipped",
        PROSE_ONLY: "",
        METADATA_ONLY: "",
      }),
    ).toBe(0)
    for (const base of [full, light]) {
      for (const result of ["failure", "cancelled", "skipped", ""])
        expect(run({ ...base, SCOPE_RESULT: result })).toBe(1)
      for (const key of ["PROSE_ONLY", "METADATA_ONLY"])
        for (const value of ["", "unknown"]) expect(run({ ...base, [key]: value })).toBe(1)
      for (const key of ["LANE_0", "LANE_1", "LANE_2", "LANE_3"])
        for (const result of ["failure", "cancelled", "", base === full ? "skipped" : "success"])
          expect(run({ ...base, [key]: result })).toBe(1)
    }
    expect(run({ ...light, METADATA_ONLY: "true" })).toBe(1)
    expect(run({ ...light, EVENT_NAME: "push" })).toBe(1)
    expect(run({ ...full, EVENT_NAME: "unknown" })).toBe(1)
  })
})

test("every full CI job preserves cancellation, push and failure behavior when prose routing is added", () => {
  const metadataJobs = new Set([
    "sandbox-k8s",
    "sandbox-k8s-e2e",
    "sandbox-docker-e2e",
    "chart-apply-smoke",
  ])
  for (const [id, job] of Object.entries(workflow.jobs) as [
    string,
    { if?: string; needs?: string },
  ][]) {
    if (["metadata_scope", "changesets", "validate"].includes(id)) continue
    expect(job.needs).toBe("metadata_scope")
    const source = String(job.if)
      .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
      .trim()
    for (const cancelled of [false, true])
      for (const event of ["push", "pull_request"]) {
        for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
          for (const proseOnly of ["true", "false", ""])
            for (const metadataOnly of ["true", "false", ""]) {
              for (const fork of [false, true]) {
                const expression = source
                  .replaceAll("cancelled()", JSON.stringify(cancelled))
                  .replaceAll("github.event_name", JSON.stringify(event))
                  .replaceAll(
                    "github.event.pull_request.head.repo.full_name",
                    JSON.stringify(fork ? "fork/repo" : "owner/repo"),
                  )
                  .replaceAll("github.repository", JSON.stringify("owner/repo"))
                  .replaceAll("github.ref", JSON.stringify("refs/heads/main"))
                  .replaceAll("needs.metadata_scope.result", JSON.stringify(result))
                  .replaceAll("needs.metadata_scope.outputs.prose_only", JSON.stringify(proseOnly))
                  .replaceAll(
                    "needs.metadata_scope.outputs.metadata_only",
                    JSON.stringify(metadataOnly),
                  )
                const actual = Function(`"use strict"; return (${expression});`)()
                const expected =
                  !cancelled &&
                  !(
                    event === "pull_request" &&
                    result === "success" &&
                    (proseOnly === "true" || (metadataJobs.has(id) && metadataOnly === "true"))
                  ) &&
                  !(id === "vercel-native" && event === "pull_request" && fork)
                expect(
                  actual,
                  JSON.stringify({ id, cancelled, event, result, proseOnly, metadataOnly, fork }),
                ).toBe(expected)
              }
            }
        }
      }
  }
})

test("prose classification uses the merge base even when source changes match the current base endpoint", async () => {
  const repo = repository()
  try {
    repo.git("checkout", "-b", "feature")
    repo.write(prose, "Updated notes.\n")
    repo.write("source.ts", "export const value = 1\n")
    const head = repo.commit()
    repo.git("checkout", "main")
    repo.write("source.ts", "export const value = 1\n")
    const base = repo.commit()
    expect(await classify({ event: "pull_request", base, head }, repo.runner)).toBe(false)
  } finally {
    repo.close()
  }
})

test("the prose CLI emits one boolean and rejects invalid selectors", () => {
  const repo = repository()
  try {
    const base = repo.git("rev-parse", "HEAD")
    repo.write(prose, "Updated notes.\n")
    const head = repo.commit()
    const run = (kind: string) =>
      spawnSync(
        process.execPath,
        [
          resolve(root, "scripts/ci-scope.mjs"),
          "--kind",
          kind,
          "--event",
          "pull_request",
          "--base",
          base,
          "--head",
          head,
        ],
        { cwd: repo.directory, encoding: "utf8", timeout: 5000 },
      )
    const result = run("prose")
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("true\n")
    expect(result.stderr).toBe("")
    expect(run("metadata").stdout).toBe("false\n")
    const invalid = run("unknown")
    expect(invalid.status).toBe(1)
    expect(invalid.stdout).toBe("")
  } finally {
    repo.close()
  }
})

describe("trusted-base scope shell", () => {
  test.each(["forged-head", "legacy-base", "current-prose", "classifier-failure"])(
    "uses trusted scope code for %s",
    (scenario) => {
      const repo = repository()
      const output = resolve(repo.directory, "github-output")
      const temporary = mkdtempSync(resolve(tmpdir(), "b4-scope-shell-"))
      try {
        let trustedSource = readFileSync(resolve(root, "scripts/ci-scope.mjs"), "utf8")
        if (scenario === "legacy-base") {
          trustedSource = `
            import { pathToFileURL } from "node:url"
            export async function classifyMetadataOnlyScope() { return false }
            if (import.meta.url === pathToFileURL(process.argv[1]).href) {
              if (process.argv.includes("--kind")) throw new Error("Unknown flag: --kind")
              process.stdout.write("false\\n")
            }
          `
        }
        if (scenario === "classifier-failure")
          trustedSource = 'throw new Error("trusted failure")\n'
        repo.write("scripts/ci-scope.mjs", trustedSource)
        const base = repo.commit()
        repo.write(prose, "Updated runbook.\n")
        if (scenario === "forged-head") {
          repo.write(
            "scripts/ci-scope.mjs",
            `
            import { writeFileSync } from "node:fs"
            writeFileSync("forged-classifier-ran", "unsafe")
            process.stdout.write(process.argv.includes("--kind") ? "true\\n" : "false\\n")
          `,
          )
          repo.write("source.ts", "export const changed = true\n")
        }
        const head = repo.commit()
        const command = workflow.jobs.metadata_scope.steps.find(
          (step: { id?: string }) => step.id === "classify",
        ).run
        const result = spawnSync("/bin/bash", ["-c", command], {
          cwd: repo.directory,
          env: {
            ...process.env,
            BASE_SHA: base,
            HEAD_SHA: head,
            GITHUB_OUTPUT: output,
            TMPDIR: temporary,
          },
          encoding: "utf8",
          timeout: 5000,
        })
        expect(existsSync(resolve(repo.directory, "forged-classifier-ran"))).toBe(false)
        expect(readdirSync(temporary)).toEqual([])
        if (scenario === "classifier-failure") {
          expect(result.status).not.toBe(0)
          expect(existsSync(output) ? readFileSync(output, "utf8") : "").toBe("")
        } else {
          expect(result.status, result.stderr).toBe(0)
          expect(readFileSync(output, "utf8").trim().split("\n").sort()).toEqual([
            "metadata_only=false",
            `prose_only=${scenario === "current-prose"}`,
          ])
        }
      } finally {
        repo.close()
        rmSync(temporary, { recursive: true, force: true })
      }
    },
  )
})
