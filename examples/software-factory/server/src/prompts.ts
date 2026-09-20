import { type CatalogOptions, loadTask, loadTaskIds, type Task } from "./targets/catalog.js"

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
 * Every task the catalog can currently serve, keyed by id: the controller's own
 * task-id-to-prompt table, and the set of task ids a work order may name. Derived from the
 * catalog on each call rather than compiled in, so a new task is a directory and a prepared
 * image, not a code change.
 *
 * A task that cannot be loaded — most often a sibling target nobody has prepared on this
 * machine yet — is OMITTED and reported through `onUnavailable`, and this function never
 * throws. One unprepared target must not decide whether the controller boots: a work order
 * naming that task is refused as unknown, which is a fact about that task, while every other
 * task in the catalog keeps working.
 */
export function taskPrompts(
  onUnavailable?: (id: string, error: unknown) => void,
  options?: CatalogOptions,
): Readonly<Record<string, string>> {
  let ids: string[]
  try {
    ids = loadTaskIds(options?.tasksDir)
  } catch (error) {
    // No catalog at all is reported the same way rather than thrown: the caller asked for
    // the tasks that are available, and the answer is none.
    onUnavailable?.("(catalog)", error)
    return {}
  }
  const prompts: Record<string, string> = {}
  for (const id of ids) {
    try {
      prompts[id] = taskPrompt(loadTask(id, options ?? {}))
    } catch (error) {
      onUnavailable?.(id, error)
    }
  }
  return prompts
}
