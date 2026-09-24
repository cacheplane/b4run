import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ControllerContext } from "../src/lib/controller/context.ts"
import {
  CARRIED_DECISIONS,
  CARRIED_NOTE_CHARS,
  carriedDecisions,
} from "../src/lib/controller/intake.ts"
import type { FactoryEvent, WorkOrderRow } from "../src/lib/domain/work-order.ts"
import {
  intakePrompt,
  preparedTargets,
  ROOT_RULE,
  targetLine,
  targetNotes,
} from "../src/lib/prompts.ts"
import {
  environmentIdentity,
  imageTag,
  loadTarget,
  loadTargetIds,
  TargetSchema,
  targetsDir,
  tasksDir,
} from "../src/lib/targets/catalog.ts"
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

  it("renders a target's drafting notes under its line, and only its own", () => {
    const cli = loadTarget("cli")
    const notes = cli.draftingNotes ?? []
    expect(notes.length).toBeGreaterThan(0)
    const prompt = intakePrompt({ pin: shippedPin("cli"), issueText: ISSUE })
    const block = [
      targetLine(cli),
      "  Notes for writing a check against `cli`:",
      ...notes.map((note) => `  - ${note}`),
    ].join("\n")
    expect(prompt).toContain(`${block}\n`)
    expect(targetNotes(cli)).toEqual(block.split("\n").slice(1))
    // Attempt 4's check exported a default function and named `/noop#graph`: the notes say
    // which exports discovery recognises and how the route key is spelled.
    expect(prompt).toContain("`B4_E1007`")
    expect(prompt).toContain("`/noop#workflow`")
    expect(prompt).toContain("packages/cli/dist/runtime-exports.js")
    // A target without notes renders none.
    expect(targetNotes({ id: "x" })).toEqual([])
    expect(targetNotes({ id: "x", draftingNotes: [] })).toEqual([])
  })

  it("keeps drafting notes out of the image: editing them needs no target:prepare", () => {
    const cli = loadTarget("cli")
    const edited = { ...cli, draftingNotes: ["something else entirely"] }
    const bare = { ...cli, draftingNotes: undefined }
    expect(imageTag(edited)).toBe(imageTag(cli))
    expect(imageTag(bare)).toBe(imageTag(cli))
    expect(environmentIdentity(edited)).toBe(environmentIdentity(cli))
  })

  it("bounds drafting notes: one line each, at most ten", () => {
    const shipped = JSON.parse(readFileSync(join(targetsDir, "cli", "target.json"), "utf8"))
    const parse = (draftingNotes: unknown) =>
      TargetSchema.safeParse({ ...shipped, draftingNotes }).success
    expect(parse(["one", "two"])).toBe(true)
    expect(parse(["two\nlines"])).toBe(false)
    expect(parse([""])).toBe(false)
    expect(parse(Array.from({ length: 11 }, (_, i) => `note ${i}`))).toBe(false)
    const { draftingNotes: _notes, ...without } = shipped
    expect(TargetSchema.safeParse(without).success).toBe(true)
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

describe("carried maintainer decisions", () => {
  it("renders them after the issue, quoted, and renders nothing without them", () => {
    const prompt = intakePrompt({
      pin: PIN,
      issueText: ISSUE,
      decisions: ["newest\nline two", "older"],
    })
    const section = prompt.slice(
      prompt.indexOf("## Maintainer decisions from earlier reviews of this issue"),
    )
    expect(prompt.indexOf("## The issue")).toBeLessThan(prompt.indexOf("## Maintainer decisions"))
    expect(section).toContain("> newest\n> line two")
    expect(section.indexOf("newest")).toBeLessThan(section.indexOf("older"))
    expect(intakePrompt({ pin: PIN, issueText: ISSUE, decisions: [] })).not.toContain(
      "Maintainer decisions",
    )
  })

  it("takes the same issue's operator notes, newest first, bounded, but not the current note", () => {
    const origin = {
      kind: "issue" as const,
      repository: "cacheplane/b4run",
      number: 714,
      bodyDigest: "0".repeat(64),
    }
    const row = (id: string, number = 714) =>
      ({ id, origin: { ...origin, number } }) as WorkOrderRow
    const rows = [row("wo-self"), row("wo-a"), row("wo-b"), row("wo-other", 778)]
    let seq = 0
    const rejected = (id: string, at: string, note: string): FactoryEvent => ({
      seq: ++seq,
      workOrderId: id,
      type: "intake_rejected",
      payload: { note, attempt: 1 },
      at,
    })
    const events: Record<string, FactoryEvent[]> = {
      "wo-self": [rejected("wo-self", "2026-09-23T09:00:00Z", "own note")],
      "wo-a": [
        rejected("wo-a", "2026-09-23T01:00:00Z", "a1"),
        rejected("wo-a", "2026-09-23T03:00:00Z", "x".repeat(CARRIED_NOTE_CHARS + 50)),
      ],
      "wo-b": [
        rejected("wo-b", "2026-09-23T02:00:00Z", "b1"),
        rejected("wo-b", "2026-09-23T04:00:00Z", "b2"),
        rejected("wo-b", "2026-09-23T05:00:00Z", "b3"),
      ],
      "wo-other": [rejected("wo-other", "2026-09-23T08:00:00Z", "another issue")],
    }
    const ctx = {
      store: { list: () => rows, events: (id: string) => events[id] ?? [] },
    } as unknown as ControllerContext
    // The row's own operator note counts: a later refusal replaces it as the turn's `note`.
    const carried = carriedDecisions(ctx, rows[0] as WorkOrderRow)
    expect(carried).toHaveLength(CARRIED_DECISIONS)
    expect(carried.slice(0, 3)).toEqual(["own note", "b3", "b2"])
    expect(carried[3]).toBe(`${"x".repeat(CARRIED_NOTE_CHARS)}…`)
    expect(carried).not.toContain("another issue")
    // Except while it IS the turn's note: quoted once, as the refusal, not twice.
    const current = carriedDecisions(ctx, rows[0] as WorkOrderRow, "own note")
    expect(current).toEqual(["b3", "b2", `${"x".repeat(CARRIED_NOTE_CHARS)}…`, "b1"])
  })
})
