import { type CatalogOptions, loadTask, type Task } from "./targets/catalog.js"

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
