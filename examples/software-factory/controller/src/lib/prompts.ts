import { DRAFT_ROOT } from "./intake/draft.js"
import {
  type CatalogOptions,
  loadTarget,
  loadTargetIds,
  loadTask,
  type Task,
} from "./targets/catalog.js"

/**
 * One invocation as the builder must type it: from the workspace root when the target's
 * commands run there, and prefixed with the target's own `cwd` when they do not.
 */
function invocation(task: Task, argv: readonly string[]): string {
  const { cwd } = task.target.commands
  const joined = argv.join(" ")
  return cwd === "." ? joined : `cd ${cwd} && ${joined}`
}

/**
 * The builder's single turn, DERIVED from the target rather than restated per task. It edits
 * files and stops. It is not asked to verify or to deliver, because it has no way to do
 * either: verification and delivery are the controller's, and nothing the builder says is
 * read as a verdict.
 *
 * The commands come from the target's own manifest — the same argv the verifier runs and the
 * same ones `b4.config.ts` pre-approves — so a target whose commands change cannot leave the
 * builder being told to run something its permissions no longer admit.
 */
export function taskPrompt(task: Task): string {
  const { commands } = task.target
  const sentences = ["Read TASK.md."]
  if (commands.cwd !== ".") sentences.push(`The package under repair is at \`${commands.cwd}\`.`)
  sentences.push(
    "Reproduce the failure with the test command below, then repair only the source files TASK.md permits you to change.",
  )
  const tests = `Run the tests with \`${invocation(task, commands.test)}\`.`
  sentences.push(
    commands.build.length > 0
      ? `Build it with \`${invocation(task, commands.build)}\` first. ${tests}`
      : tests,
  )
  sentences.push(
    "Do not edit any test or configuration.",
    "When the repair is complete and the tests pass, stop and say so.",
    "Use readFile, listDir, writeFile and runBash.",
  )
  return sentences.join(" ")
}

/**
 * The prompt for the task `id` names, resolved through the catalog at the point of use
 * rather than tabulated at boot: a task generated after the controller started is served
 * the moment its directory lands, and a task the catalog cannot load — most often a sibling
 * target nobody has prepared on this machine — throws here, for the caller to refuse that
 * one work order, and never decides whether the controller boots.
 */
export function promptFor(id: string, options: CatalogOptions = {}): string {
  return taskPrompt(loadTask(id, options))
}

/**
 * The prepared targets a draft may name, one line each with the target's root. A target the
 * catalog cannot load (no image: nobody has prepared it on this machine) is left out rather
 * than listed: `parseDraft` would refuse a draft naming it, so offering it would only be
 * offering a refusal.
 */
function preparedTargets(): string[] {
  const lines: string[] = []
  for (const id of loadTargetIds()) {
    try {
      const target = loadTarget(id)
      lines.push(`- \`${id}\` (root: \`${target.root}\`)`)
    } catch {
      // Unprepared: not something a draft can be pinned to.
    }
  }
  return lines
}

/**
 * The drafter's single turn (spec §6.4): turn an issue into a task the controller can prove
 * and a person can approve. It writes exactly four files under `draft/` and repairs nothing;
 * the repair is the builder's, later, and only once the drafted check has been shown to fail
 * on the unpatched code. `note` is the previous attempt's refusal, quoted so the redraft can
 * mend it rather than guess.
 */
export function intakePrompt(input: {
  readonly issueText: string
  readonly note?: string
}): string {
  const targets = preparedTargets()
  const sections = [
    [
      "You are drafting a repair task from a GitHub issue. Do not repair anything: write the task, not the fix.",
      `Write exactly four files under \`${DRAFT_ROOT}\` and nothing else, using writeFile:`,
      "",
      `1. \`${DRAFT_ROOT}task.json\`: a JSON object with \`target\` (one of the targets listed below), \`allowedSourcePaths\` (the repository-relative source files the repair may change) and \`immutablePaths\` (the repository-relative paths the repair must not touch, including every test directory and every configuration file the tests read). The two lists must not overlap. Do not write an \`id\`.`,
      `2. \`${DRAFT_ROOT}spec.md\`: the repair, stated for a builder who has not read the issue, ending with numbered acceptance criteria, each on its own line starting with \`A1:\`, \`A2:\` and so on.`,
      `3. \`${DRAFT_ROOT}checks.json\`: a JSON object with only \`independent\` = \`{ "runner": "node-test", "file": "checks/<name>.test.ts", "assertions": ["A1: ...", ...] }\`. Each assertion name starts with an acceptance id from the spec, and every id the spec states must be covered, with no other. Do not write a \`visible\` suite.`,
      `4. \`${DRAFT_ROOT}checks/<name>.test.ts\`: the one check file \`checks.json\` names, a \`node:test\` suite with one test per assertion, named exactly as in \`checks.json\`. It must FAIL on the current code and PASS once the issue is fixed. Import the built artifact by its repository-root-relative path (the package's \`dist/\`), never a source file. Depend on no test in the repository and on no file outside this one.`,
      "",
      "Available targets (choose the one whose package the issue is about):",
      ...(targets.length > 0 ? targets : ["- (none prepared)"]),
      "",
      "Use readFile, listDir, writeFile and runBash to read the repository. When the four files are written, stop and say so.",
    ].join("\n"),
    ["## The issue", "", input.issueText.replace(/\n*$/, "")].join("\n"),
  ]
  if (input.note !== undefined)
    sections.push(
      [
        "## Previous attempt was refused",
        "",
        "The controller refused the last draft for this reason; mend it in this one:",
        "",
        `> ${input.note.replace(/\n/g, "\n> ")}`,
      ].join("\n"),
    )
  return `${sections.join("\n\n")}\n`
}
