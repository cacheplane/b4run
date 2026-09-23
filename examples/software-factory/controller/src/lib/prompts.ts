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
 * The targets prepared AT `pin` a draft may name, one line each with the target's root. A
 * target the catalog cannot load there (no image at the pin: nobody has run
 * `target:prepare <id> --pin <pin>` on this machine) is left out rather than listed:
 * `parseDraft` would refuse a draft naming it, so offering it would only be offering a
 * refusal.
 */
export function preparedTargets(
  pin: string,
  /** Test-only: the catalog to list; the shipped one otherwise. */
  catalog: Pick<CatalogOptions, "targetsDir" | "repositoryRoot"> = {},
): string[] {
  const lines: string[] = []
  for (const id of loadTargetIds(catalog.targetsDir)) {
    try {
      const target = loadTarget(id, { ...catalog, pin })
      lines.push(`- \`${id}\` (root: \`${target.root}\`)`)
    } catch {
      // Unprepared at this pin: not something this work order's draft can name.
    }
  }
  return lines
}

/**
 * The drafter's single turn (spec §6.4): what varies from one work order to the next. The
 * fixed rules — the four files and their shapes, `draft/` only, no repair, the check's
 * contract — are the drafter route's own system prompt (`drafter/src/app/intake/index.ts`),
 * which this message points at rather than restates. What only the controller knows goes
 * here: the issue, the targets prepared on this machine at the work order's pin with their
 * roots (a draft naming any other would only be refused), and the previous attempt's
 * refusal, quoted so the redraft can mend it rather than guess.
 */
export function intakePrompt(input: {
  readonly pin: string
  readonly issueText: string
  readonly note?: string
  /** Test-only: where the targets are looked up; the shipped catalog otherwise. */
  readonly catalog?: Pick<CatalogOptions, "targetsDir" | "repositoryRoot">
}): string {
  const targets = preparedTargets(input.pin, input.catalog)
  const sections = [
    [
      `You are drafting a repair task from the GitHub issue below. Write the four files under \`${DRAFT_ROOT}\` (\`${DRAFT_ROOT}task.json\`, \`${DRAFT_ROOT}spec.md\`, \`${DRAFT_ROOT}checks.json\` and \`${DRAFT_ROOT}checks/<name>.test.ts\`) as your instructions say. Do not repair anything: write the task, not the fix.`,
      "",
      `The repository is under \`repo/\`, checked out at ${input.pin}. Available targets, those prepared at that commit (choose the one whose package the issue is about), each with its root inside the repository:`,
      ...(targets.length > 0 ? targets : ["- (none prepared)"]),
      "",
      "Every path in `task.json` and every import in the check file is relative to the chosen target's root, not to `repo/` and not to the repository's root.",
      "",
      "When the four files are written, stop and say so.",
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
