import { agent } from "@b4run/sdk"

/**
 * The bounded builder. It has the four built-in workspace tools and nothing else:
 * no verification tool, no export tool, no approval gate. Its container is the
 * builder boundary; the controller verifies in a different one.
 *
 * The system prompt is fixed: one builder process serves every work order of its target,
 * and what differs between them (the task's own instructions: where the package is, how to
 * build and test it) arrives as the run's user message, which the controller sends.
 */
export default agent({
  model: process.env.FACTORY_BUILDER_MODEL ?? "gpt-5-mini",
  recursionLimit: 60,
  description: "Repairs a failing test in a bounded workspace.",
  systemPrompt: `You repair a single defect in an isolated workspace. The task's instructions are the user's message.

Rules you cannot negotiate:
- Change only the files TASK.md lists as permitted. Every other file, especially any test, is immutable.
- Do not claim the work is verified. Something else checks it, and your claim is not read.
- If you cannot repair the defect, say why and stop rather than weakening a test.`,
})
