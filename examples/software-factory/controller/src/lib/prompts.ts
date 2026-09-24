import { DRAFT_ROOT } from "./intake/draft.js"
import {
  type CatalogOptions,
  loadTarget,
  loadTargetIds,
  loadTask,
  type Target,
  type Task,
} from "./targets/catalog.js"
import { builderPermissions } from "./targets/permissions.js"

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
 * How the builder works, stated once, here: the builder route's system prompt keeps only the
 * non-negotiables (scope, no verdict, no weakened test) and points at this message for the
 * rest. The first live run's builder read a 3,644-line file whole, wrote it back with
 * `writeFile` truncated to 670 lines ending in `... (file truncated, unchanged)`, and then
 * parked on `sed -n`, which its permissions did not list. Each rule answers one of those.
 * `editFile` and `readFile`'s `startLine`/`endLine` are the workspace capability's own
 * tools; the controller's assembly refuses an elided file whatever the prompt said.
 */
export function builderRules(task: Task): string[] {
  const { commands } = task.target
  const invocations = new Set(
    [commands.build, commands.test]
      .filter((argv) => argv.length > 0)
      .flatMap((argv) => [argv.join(" "), invocation(task, argv)]),
  )
  const others = builderPermissions(task.target)
    .bash.filter((prefix) => !invocations.has(prefix))
    .map((prefix) => `\`${prefix.trimEnd()}\``)
  const named = commands.build.length > 0 ? "the build and test commands" : "the test command"
  return [
    "Change an existing file with `editFile`, which replaces one exact span of its text with another. Never rewrite an existing file with `writeFile`: every file you may change already exists, and rewriting one whole loses whatever you did not reproduce.",
    "Read a large file in ranges: `readFile` with `startLine` and `endLine`, or find the lines with `grep -n` and read around them with `sed -n '<from>,<to>p'`. Do not read a large file whole.",
    "Never write placeholder or elision text into a file (a line such as `...` standing in for omitted code, `(file truncated)`, `rest of the file unchanged`): every line you write is the file's content. A changed file carrying such a line, or smaller than half its original size, is refused before it is tested.",
    `Run ${named} above to confirm the repair before you stop.`,
    `The commands you may run are ${named} above, exactly as written (appending flags is fine), and commands starting with ${others.join(", ")}. Any other command is refused with an error; do not retry it under another name or through \`bash -c\`.`,
    "Your tools are readFile, listDir, editFile, writeFile and runBash.",
  ]
}

/**
 * The builder's single turn, DERIVED from the target rather than restated per task. It edits
 * files and stops. It is not asked to verify or to deliver, because it has no way to do
 * either: verification and delivery are the controller's, and nothing the builder says is
 * read as a verdict.
 *
 * The commands come from the target's own manifest — the same argv the verifier runs and the
 * same ones `b4.config.ts` pre-approves — so a target whose commands change cannot leave the
 * builder being told to run something its permissions no longer admit. The rules that follow
 * the instructions (`builderRules`) are the same for every task but name the target's list.
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
    `When the repair is complete and ${commands.build.length > 0 ? "the build and tests pass" : "the tests pass"}, stop and say so.`,
  )
  const rules = builderRules(task).map((rule) => `- ${rule}`)
  return [sentences.join(" "), "", "Rules:", ...rules].join("\n")
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
 * One target as a drafter must read it: its root, what a path under that root looks like
 * (from the target's own capture, so the example is a directory that exists), where the
 * build writes the artifact a check imports, and that the runner configuration is not the
 * drafter's to list. The live run's drafter read a root of `.` as the package and wrote
 * `src/...` paths; the example is what makes the root unambiguous.
 */
export function targetLine(
  target: Pick<Target, "id" | "root" | "capture" | "commands" | "snapshotIgnore">,
): string {
  const pkg = target.commands.cwd === "." ? "" : `${target.commands.cwd}/`
  const includes = target.capture.include
  const source =
    includes.find((path) => path === `${pkg}src`) ??
    includes.find((path) => path === "src" || path.endsWith("/src")) ??
    includes[0]
  const facts: string[] = []
  if (target.root === ".") {
    const wrong = pkg !== "" && source?.startsWith(pkg) ? source.slice(pkg.length) : null
    facts.push(
      `the repository root: paths start at the repository root and look like \`${source}/...\`${wrong ? `, never \`${wrong}/...\`` : ""}`,
    )
  } else facts.push(`paths start inside that directory and look like \`${source}/...\``)
  const built = target.snapshotIgnore.find((prefix) => prefix === `${pkg}dist/`)
  // ESM resolves an import specifier against the importing file, not the working directory:
  // "imports the built artifact by that path" read as `import "packages/.../dist/x.js"` is
  // ERR_MODULE_NOT_FOUND. The check runs from the target root, so it goes through `cwd`.
  if (built && target.commands.build.length > 0)
    facts.push(
      `the build writes \`${built}\`, and the check loads the built artifact with \`await import(join(process.cwd(), "${built}<file>.js"))\``,
    )
  facts.push("its runner configuration is fixed by the factory")
  return `- \`${target.id}\` (root: \`${target.root}\`, ${facts.join("; ")})`
}

/**
 * A target's `draftingNotes`, as bullets nested under its `targetLine`: what only the
 * target's own code can tell a drafter (attempt 4's check wrote a route with a default export,
 * which the runtime refused as `B4_E1007` before the check reached the behaviour).
 */
export function targetNotes(target: Pick<Target, "id" | "draftingNotes">): string[] {
  const notes = target.draftingNotes ?? []
  if (notes.length === 0) return []
  return [`  Notes for writing a check against \`${target.id}\`:`, ...notes.map((n) => `  - ${n}`)]
}

/**
 * The targets prepared AT `pin` a draft may name, one line each (`targetLine`), each
 * followed by its drafting notes (`targetNotes`). A
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
      lines.push(targetLine(target), ...targetNotes(target))
    } catch {
      // Unprepared at this pin: not something this work order's draft can name.
    }
  }
  return lines
}

/**
 * How a path is spelled, stated the same way here and in the drafter's system prompt. A root
 * of `.` is said outright to be the repository root: the live run's drafter, told paths were
 * "not relative to the repository's root", wrote them relative to the package instead. The
 * check's imports are NOT relative to the root (ESM resolves them against the check file), so
 * the rule says how the check reaches the root instead: through `process.cwd()`, as the
 * shipped reference checks do.
 */
export const ROOT_RULE =
  "Every path in `task.json` is relative to the chosen target's root, not to `repo/`. A root of `.` is the repository root: paths then start there (`packages/<name>/...`), never at the package. The check runs with the target's root as its working directory and loads the built artifact with `await import(join(process.cwd(), \"packages/<name>/dist/<file>.js\"))`, never a relative `import` specifier, which resolves against the check file's own directory."

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
  /**
   * The maintainer's notes from rejecting earlier drafts of the SAME issue on other work
   * orders, newest first (`carriedDecisions`): what a reviewer decided about the issue (which
   * status an empty result answers with, say) outlives the work order it was written on.
   */
  readonly decisions?: readonly string[]
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
      ROOT_RULE,
      "",
      "When the four files are written, stop and say so.",
    ].join("\n"),
    ["## The issue", "", input.issueText.replace(/\n*$/, "")].join("\n"),
  ]
  if (input.decisions !== undefined && input.decisions.length > 0)
    sections.push(
      [
        "## Maintainer decisions from earlier reviews of this issue",
        "",
        "A person reviewing an earlier draft of this same issue rejected it with these notes, newest first. They are decisions about the issue, not about that draft: honour them.",
        ...input.decisions.map((decision) => `\n> ${decision.replace(/\n/g, "\n> ")}`),
      ].join("\n"),
    )
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
