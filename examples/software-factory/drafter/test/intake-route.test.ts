import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The real intake turn runs in the Docker lane (Task 5). Here the route's static shape: the
 * fixed rules the controller's `intakePrompt` relies on, stated in the system prompt so a
 * user message that omitted one would still not move them.
 */
const loadRoute = async () => (await import("../src/app/intake/index.ts")).default

beforeEach(() => {
  delete process.env.FACTORY_DRAFTER_MODEL
  vi.resetModules()
})
afterEach(() => {
  delete process.env.FACTORY_DRAFTER_MODEL
})

describe("the intake route", () => {
  it("uses gpt-5-mini unless FACTORY_DRAFTER_MODEL says otherwise", async () => {
    expect((await loadRoute()).model).toBe("gpt-5-mini")
    process.env.FACTORY_DRAFTER_MODEL = "gpt-5"
    vi.resetModules()
    expect((await loadRoute()).model).toBe("gpt-5")
  })

  it("is bounded and brings no tool of its own", async () => {
    const route = await loadRoute()
    expect(route.recursionLimit).toBeGreaterThan(0)
    expect(route.recursionLimit).toBeLessThanOrEqual(200)
    expect(route.tools).toBeUndefined()
  })

  it("names only bash commands the config's allow-list admits", async () => {
    // Non-interactive mode denies anything off the list; a command the prompt recommends
    // and the list omits would be a fail-closed denial per call, each burning a step.
    const prompt = (await loadRoute()).systemPrompt ?? ""
    const named = prompt.match(/runBash \(([^)]*)\)/)?.[1]
    expect(named).toBeDefined()
    const commands = (named as string).split(",").map((c) => c.trim())
    expect(commands.length).toBeGreaterThan(0)
    const config = (await import("../b4.config.ts")).default as {
      permissions?: { allow?: { bash?: string[] } }
    }
    const allowed = config.permissions?.allow?.bash ?? []
    for (const command of commands) expect(allowed).toContain(command)
  })

  it("states the fixed rules the controller's prompt relies on", async () => {
    const prompt = (await loadRoute()).systemPrompt ?? ""
    // Where things are.
    expect(prompt).toMatch(/repository .*`repo\/`/)
    // Exactly four files, and the directory first.
    expect(prompt).toContain("exactly four files")
    for (const file of ["draft/task.json", "draft/spec.md", "draft/checks.json"])
      expect(prompt).toContain(`\`${file}\``)
    expect(prompt).toMatch(/`draft\/checks\/<name>\.test\.ts`/)
    expect(prompt).toMatch(/create .*`draft\/` .*first/i)
    // Each file's shape is the route's to state: the controller's message names the files
    // and the targets, and restates none of this.
    expect(prompt).toMatch(/`allowedSourcePaths`/)
    expect(prompt).toMatch(/`immutablePaths`/)
    expect(prompt).toMatch(/must not overlap/)
    expect(prompt).toMatch(/`A1:`, `A2:`/)
    expect(prompt).toMatch(/"runner": "node-test"/)
    expect(prompt).toMatch(/every id the spec states must be covered/)
    expect(prompt).toMatch(/Do not write a `visible` suite/)
    expect(prompt).toMatch(/one test per assertion/)
    // What it must never do.
    expect(prompt).toMatch(/never write .*`repo\/`/i)
    expect(prompt).toMatch(/never repair/i)
    // Paths are relative to the target's root, which the user message names, not to repo/.
    expect(prompt).toMatch(/relative to the target's root/)
    expect(prompt).toMatch(/not to `repo\/`/)
    // The check: node:test, fails now, passes when fixed, built artifact, no repository test.
    expect(prompt).toContain("`node:test`")
    // The skeleton: the imports the controller's pre-check requires, the build loaded through
    // the working directory, one named test, and cleanup that cannot throw.
    expect(prompt).toContain('import { after, test } from "node:test"')
    expect(prompt).toContain('import assert from "node:assert/strict"')
    expect(prompt).toContain('import { join } from "node:path"')
    expect(prompt).toContain('await import(join(process.cwd(), "packages/<name>/dist/<file>.js"))')
    expect(prompt).toMatch(/^test\("A1: /m)
    expect(prompt).toContain(".catch(() => {})")
    expect(prompt).toMatch(/fails? on the current code/i)
    expect(prompt).toMatch(/pass(es)? (once|when) .*fixed/i)
    expect(prompt).toMatch(/built artifact/)
    expect(prompt).toMatch(/no (test in the repository|repository test)/i)
    // A root of `.` is the repository root, never the package: the live run's drafter wrote
    // package-relative paths.
    expect(prompt).toContain("A root of `.` is the repository root")
    expect(prompt).toMatch(/never at the package/)
    // The check runs after the build, from the target root, against dist, through real code.
    expect(prompt).toMatch(/target's root as its working directory, after the target's build/)
    expect(prompt).toContain("`packages/<name>/dist/...`")
    expect(prompt).toMatch(/real code path/)
    expect(prompt).toContain("never `assert.ok(true)`")
    // ESM resolves a specifier against the importing file, so the artifact is loaded through
    // process.cwd(), the way the shipped reference checks do: the review's ERR_MODULE_NOT_FOUND.
    expect(prompt).toContain('await import(join(process.cwd(), "packages/<name>/dist/<file>.js"))')
    expect(prompt).toMatch(/never a relative `import` specifier/)
    // Graded shape: flat top-level tests, node:assert, a cleanup that cannot throw.
    expect(prompt).toMatch(/Flat, top-level `test\("A<n>: \.\.\."/)
    expect(prompt).toMatch(/No `describe`/)
    expect(prompt).toContain("`node:assert/strict`")
    expect(prompt).toMatch(/never chai or vitest `expect`/)
    expect(prompt).toMatch(/Cleanup .* must not throw/)
    // At least one fails now; a regression guard may pass; none is vacuous.
    expect(prompt).toMatch(/at least one `A<n>` test fails on the current code/)
    expect(prompt).toMatch(/none is vacuous/)
    expect(prompt).not.toMatch(/Every `A<n>` test must assert something that fails/)
    // Acceptance criteria are observable behaviour; scope is task.json's.
    expect(prompt).toMatch(/acceptance criterion is an observable behaviour/)
    expect(prompt).toMatch(/Scope is never an acceptance criterion/)
    // Large files in ranges; no shell wrapper.
    expect(prompt).toMatch(/Read large files in ranges/)
    expect(prompt).toContain("`sed -n '120,200p' <file>`")
    expect(prompt).toMatch(/never with `bash -lc` or `sh -c`/)
    // The runner configuration is the factory's to fill, never the drafter's to allow.
    expect(prompt).toMatch(/runner configuration .* fixed by the factory/)
  })
})

describe("the package boundary", () => {
  it("imports no controller source, anywhere", () => {
    const root = fileURLToPath(new URL("../", import.meta.url))
    const files = [join(root, "b4.config.ts")]
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const child = join(directory, entry.name)
        if (entry.isDirectory()) walk(child)
        else if (entry.isFile() && child.endsWith(".ts")) files.push(child)
      }
    }
    walk(join(root, "src"))
    expect(files.length).toBeGreaterThan(1)
    for (const file of files) {
      expect([file, readFileSync(file, "utf8").includes("../controller/")]).toEqual([file, false])
    }
  })

  it("declares no dependency on the controller package either", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    expect(declared.some((name) => name.includes("software-factory-controller"))).toBe(false)
  })
})
