import { agent } from "@b4run/sdk"
import { taskPrompt } from "../../prompts.js"
import { loadTask } from "../../targets/catalog.js"

/**
 * The bounded builder. It has the four built-in workspace tools and nothing else:
 * no verification tool, no export tool, no approval gate. Its container is the
 * builder boundary; the controller verifies in a different one.
 */
export default agent({
  model: process.env.FACTORY_BUILDER_MODEL ?? "gpt-5-mini",
  recursionLimit: 60,
  description: "Repairs a failing test in a bounded workspace.",
  systemPrompt: `You repair a single defect in an isolated workspace.

${taskPrompt(loadTask(process.env.FACTORY_TASK_ID ?? "cli-flags"))}

Rules you cannot negotiate:
- Change only the files TASK.md lists as permitted. Every other file, especially any test, is immutable.
- Do not claim the work is verified. Something else checks it, and your claim is not read.
- If you cannot repair the defect, say why and stop rather than weakening a test.`,
})
