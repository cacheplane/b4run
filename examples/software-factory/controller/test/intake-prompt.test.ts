import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { intakePrompt } from "../src/lib/prompts.ts"
import { loadTarget, loadTargetIds } from "../src/lib/targets/catalog.ts"

const ISSUE =
  "# Spawn leaks a timer (cacheplane/b4run#778)\n\nA failing spawn leaves its deadline running.\n"

const drafterSystemPrompt = () =>
  readFileSync(new URL("../../drafter/src/app/intake/index.ts", import.meta.url), "utf8")

describe("intakePrompt", () => {
  it("carries what varies: the issue, the four file names, and the prepared targets with roots", () => {
    const prompt = intakePrompt({ issueText: ISSUE })
    expect(prompt).toContain(ISSUE)
    for (const file of ["draft/task.json", "draft/spec.md", "draft/checks.json", "draft/checks/"])
      expect(prompt).toContain(file)
    // Every prepared target, with its root, so the drafter can name one that exists.
    for (const id of loadTargetIds()) {
      const target = loadTarget(id)
      expect(prompt).toContain(`\`${id}\``)
      expect(prompt).toContain(target.root)
    }
    expect(prompt).toMatch(/[Dd]o not repair/)
    expect(prompt).toContain("as your instructions say")
    expect(prompt).not.toContain("Previous attempt")
  })

  it("leaves the fixed rules to the drafter's own system prompt", () => {
    const prompt = intakePrompt({ issueText: ISSUE })
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
    const prompt = intakePrompt({ issueText: ISSUE })
    expect(prompt).toContain("The repository is under `repo/`")
    // Each target with its root, so the drafter can find the package under `repo/`.
    for (const id of loadTargetIds())
      expect(prompt).toContain(`- \`${id}\` (root: \`${loadTarget(id).root}\`)`)
    // The one sentence the drafter's own system prompt states the same way: paths in the
    // manifest and imports in the check are relative to the target's root, not to `repo/`
    // and not to the repository's root.
    const sentence =
      "Every path in `task.json` and every import in the check file is relative to the chosen target's root, not to `repo/` and not to the repository's root."
    expect(prompt).toContain(sentence)
    expect(prompt).not.toMatch(/repository-relative/)
    expect(prompt).not.toMatch(/repository-root-relative/)
    expect(drafterSystemPrompt()).toContain(
      "relative to the target's root, not to \\`repo/\\` and not to the repository's root",
    )
  })

  it("quotes the previous attempt's refusal when a note is given", () => {
    const note = "draft/spec.md states [A1, A2] but the check covers [A1]"
    const prompt = intakePrompt({ issueText: ISSUE, note })
    expect(prompt).toContain("Previous attempt was refused")
    expect(prompt).toContain(note)
    // The note follows the issue: the instruction, the issue, then what went wrong last time.
    expect(prompt.indexOf(ISSUE)).toBeLessThan(prompt.indexOf(note))
  })
})
