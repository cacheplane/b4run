import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { intakePrompt, preparedTargets, ROOT_RULE, targetLine } from "../src/lib/prompts.ts"
import { loadTarget, loadTargetIds, targetsDir, tasksDir } from "../src/lib/targets/catalog.ts"
import { shippedPin } from "./temp-repo.ts"

const PIN = shippedPin("devkit")

const ISSUE =
  "# Spawn leaks a timer (cacheplane/b4run#778)\n\nA failing spawn leaves its deadline running.\n"

const drafterSystemPrompt = () =>
  readFileSync(new URL("../../drafter/src/app/intake/index.ts", import.meta.url), "utf8")

describe("intakePrompt", () => {
  it("carries what varies: the issue, the four file names, and the prepared targets with roots", () => {
    const prompt = intakePrompt({ pin: PIN, issueText: ISSUE })
    expect(prompt).toContain(ISSUE)
    for (const file of ["draft/task.json", "draft/spec.md", "draft/checks.json", "draft/checks/"])
      expect(prompt).toContain(file)
    // Every target prepared at the pin, with its root, so the drafter can name one that
    // exists. Each shipped target at its own default pin: they are re-pinned independently.
    for (const id of loadTargetIds()) {
      const target = loadTarget(id)
      const atItsPin = intakePrompt({ pin: shippedPin(id), issueText: ISSUE })
      expect(atItsPin).toContain(`\`${id}\``)
      expect(atItsPin).toContain(target.root)
    }
    expect(prompt).toContain("`devkit`")
    expect(prompt).toMatch(/[Dd]o not repair/)
    expect(prompt).toContain("as your instructions say")
    expect(prompt).not.toContain("Previous attempt")
  })

  it("leaves the fixed rules to the drafter's own system prompt", () => {
    const prompt = intakePrompt({ pin: PIN, issueText: ISSUE })
    // The file shapes, the acceptance-id form and the runner are stated once, by the route
    // that runs the turn; the user message does not restate them.
    for (const rule of ["allowedSourcePaths", "immutablePaths", "A1:", "node-test", "visible"])
      expect(prompt).not.toContain(rule)
    expect(prompt).not.toMatch(/runBash/)
    const drafter = drafterSystemPrompt()
    expect(drafter).toMatch(/allowedSourcePaths/)
    expect(drafter).toMatch(/immutablePaths/)
    expect(drafter).toMatch(/A1:/)
    expect(drafter).toMatch(/node-test/)
    expect(drafter).toMatch(/Do not write a .*visible.* suite/)
  })

  it("places the repository under repo/ and every path relative to the target's root", () => {
    const prompt = intakePrompt({ pin: PIN, issueText: ISSUE })
    expect(prompt).toContain(`The repository is under \`repo/\`, checked out at ${PIN}`)
    // Each target with its root, so the drafter can find the package under `repo/`.
    for (const id of loadTargetIds())
      expect(intakePrompt({ pin: shippedPin(id), issueText: ISSUE })).toContain(
        `- \`${id}\` (root: \`${loadTarget(id).root}\`, `,
      )
    // The one rule the drafter's own system prompt states the same way: paths are relative
    // to the target's root, and a root of `.` is the repository root, never the package.
    expect(prompt).toContain(ROOT_RULE)
    expect(ROOT_RULE).toContain("A root of `.` is the repository root")
    // Paths in task.json are root-relative; the check's imports are not (ESM resolves them
    // against the check file), so the rule names how the check reaches the root instead.
    expect(ROOT_RULE).not.toMatch(/every import in the check file is relative/)
    expect(ROOT_RULE).toContain(
      'loads the built artifact with `await import(join(process.cwd(), "packages/<name>/dist/<file>.js"))`',
    )
    expect(ROOT_RULE).toContain("never a relative `import` specifier")
    expect(prompt).not.toContain("not to the repository's root")
    expect(prompt).not.toMatch(/repository-relative/)
    expect(prompt).not.toMatch(/repository-root-relative/)
    const drafter = drafterSystemPrompt()
    expect(drafter).toContain("relative to the target's root, not to \\`repo/\\`")
    expect(drafter).toContain(
      "A root of \\`.\\` is the repository root: paths then start there (\\`packages/<name>/...\\`), never at the package",
    )
    expect(drafter).not.toContain("not to the repository's root")
  })

  it("renders each target with a concrete path, its built artifact and its fixed runner configuration", () => {
    const cli = targetLine(loadTarget("cli"))
    expect(cli).toBe(
      '- `cli` (root: `.`, the repository root: paths start at the repository root and look like `packages/cli/src/...`, never `src/...`; the build writes `packages/cli/dist/`, and the check loads the built artifact with `await import(join(process.cwd(), "packages/cli/dist/<file>.js"))`; its runner configuration is fixed by the factory)',
    )
    // Never "imports ... by that path": ESM resolves a bare path against the check file, and
    // the live run's reading of it was ERR_MODULE_NOT_FOUND.
    expect(cli).not.toMatch(/imports the built artifact by that path/)
    expect(intakePrompt({ pin: shippedPin("cli"), issueText: ISSUE })).toContain(cli)
    // A root inside the repository: paths start in it, and a target with no build names no
    // artifact.
    expect(targetLine(loadTarget("cli-flags"))).toBe(
      `- \`cli-flags\` (root: \`${loadTarget("cli-flags").root}\`, paths start inside that directory and look like \`src/...\`; its runner configuration is fixed by the factory)`,
    )
  })

  it("tells the drafter the check's contract: built artifact from the target root, a real path, real assertions", () => {
    const drafter = drafterSystemPrompt()
    expect(drafter).toContain(
      "the target's root as its working directory, after the target's build",
    )
    expect(drafter).toContain('await import(join(process.cwd(), "packages/<name>/dist/<file>.js"))')
    expect(drafter).toContain("\\`packages/<name>/dist/...\\`")
    expect(drafter).toContain("through a real code path")
    expect(drafter).toContain("never \\`assert.ok(true)\\`")
    // The runner configuration is the factory's, not the drafter's to restate.
    expect(drafter).toContain("fixed by the factory, which adds it to \\`immutablePaths\\` itself")
  })

  it("tells the drafter to load dist the way every shipped reference check does", () => {
    // The prompt's recipe is the reference checks' own: a check that loads a built `dist/`
    // file reaches it through process.cwd(), never a relative specifier.
    let checked = 0
    for (const task of readdirSync(tasksDir)) {
      const checks = join(tasksDir, task, "checks")
      let files: string[]
      try {
        files = readdirSync(checks)
      } catch {
        continue
      }
      for (const file of files) {
        const source = readFileSync(join(checks, file), "utf8")
        if (!/\/dist\b/.test(source)) continue
        checked++
        expect([file, /join\(process\.cwd\(\), "packages\/[^"]+\/dist/.test(source)]).toEqual([
          file,
          true,
        ])
        expect([file, /from ["'][./]*packages\//.test(source)]).toEqual([file, false])
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it("quotes the previous attempt's refusal when a note is given", () => {
    const note = "draft/spec.md states [A1, A2] but the check covers [A1]"
    const prompt = intakePrompt({ pin: PIN, issueText: ISSUE, note })
    expect(prompt).toContain("Previous attempt was refused")
    expect(prompt).toContain(note)
    // The note follows the issue: the instruction, the issue, then what went wrong last time.
    expect(prompt.indexOf(ISSUE)).toBeLessThan(prompt.indexOf(note))
  })

  it("lists only the targets prepared at the work order's pin, and says so", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-prompt-targets-"))
    try {
      // devkit prepared at PIN only; cli-flags prepared nowhere.
      for (const id of ["cli-flags", "devkit"]) {
        const shipped = JSON.parse(readFileSync(join(targetsDir, id, "target.json"), "utf8"))
        const { images: _images, ...rest } = shipped
        mkdirSync(join(dir, id))
        writeFileSync(
          join(dir, id, "target.json"),
          JSON.stringify(
            id === "devkit" ? { ...rest, images: { [PIN]: shipped.images[PIN] } } : rest,
          ),
        )
      }
      expect(preparedTargets(PIN, { targetsDir: dir })).toEqual([targetLine(loadTarget("devkit"))])
      expect(preparedTargets(PIN, { targetsDir: dir })[0]).toContain(
        "look like `packages/devkit/src/...`",
      )
      const elsewhere = "1".repeat(40)
      expect(preparedTargets(elsewhere, { targetsDir: dir })).toEqual([])
      const prompt = intakePrompt({
        pin: elsewhere,
        issueText: ISSUE,
        catalog: { targetsDir: dir },
      })
      expect(prompt).toContain(`checked out at ${elsewhere}`)
      expect(prompt).toContain("those prepared at that commit")
      expect(prompt).toContain("- (none prepared)")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
