import { describe, expect, it } from "vitest"
import { intakePrompt } from "../src/lib/prompts.ts"
import { loadTarget, loadTargetIds } from "../src/lib/targets/catalog.ts"

const ISSUE =
  "# Spawn leaks a timer (cacheplane/b4run#778)\n\nA failing spawn leaves its deadline running.\n"

describe("intakePrompt", () => {
  it("asks for exactly the four draft files, carries the issue text, and lists the prepared targets", () => {
    const prompt = intakePrompt({ issueText: ISSUE })
    expect(prompt).toContain(ISSUE)
    for (const file of ["draft/task.json", "draft/spec.md", "draft/checks.json", "draft/checks/"])
      expect(prompt).toContain(file)
    // The manifest fields the drafter fills, the acceptance-id shape and the one runner.
    expect(prompt).toMatch(/allowedSourcePaths/)
    expect(prompt).toMatch(/immutablePaths/)
    expect(prompt).toMatch(/A1:/)
    expect(prompt).toMatch(/node-test/)
    // Every prepared target, with its root, so the drafter can name one that exists.
    for (const id of loadTargetIds()) {
      const target = loadTarget(id)
      expect(prompt).toContain(`\`${id}\``)
      expect(prompt).toContain(target.root)
    }
    expect(prompt).toMatch(/[Dd]o not repair/)
    expect(prompt).not.toContain("Previous attempt")
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
