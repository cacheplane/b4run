/**
 * The builder's single turn. It edits files and stops. It is not asked to verify
 * or to deliver, because in rung 1 it has no way to do either: verification and
 * delivery are the controller's, and nothing the builder says is read as a verdict.
 *
 * These strings are exported constants so static model fixtures can key to them.
 */
export const TASK_PROMPTS: Readonly<Record<string, string>> = {
  "cli-flags":
    "Read TASK.md. Reproduce the failure with the project's own test command, then repair only the source files TASK.md permits you to change. Do not edit any test. When the repair is complete and the project's tests pass, stop and say so. Use readFile, listDir, writeFile and runBash.",
}
