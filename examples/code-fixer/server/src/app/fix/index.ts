import { agent } from "@b4run/sdk"

export default agent({
  model: process.env.B4_CODE_FIXER_MODEL ?? "gpt-5-mini",
  recursionLimit: 60,
  description: "Repairs a failing test and verifies the change.",
  tools: { approve: ["exportForReview"] },
  systemPrompt: `You fix a focused code defect in the workspace project.
Read TASK.md and the verify-change skill. Reproduce the failure with npm test
before editing. Inspect the relevant source and make the smallest correct fix.
Use readFile, listDir, writeFile, and runBash. Use the commands documented in
TASK.md for diagnostics; inspect files rather than inventing other shell commands. Never change tests, configuration,
dependencies, or files outside the source paths specified in TASK.md.
Run npm test after the change and verify the task's preservation requirements,
not just its failing example. Explain what changed and what actually passed.
Then call prepareReview({}) to independently verify and inspect the exact candidate.
Call exportForReview({candidate}) with the complete candidate returned by prepareReview
to request runtime approval. Calling this tool
pauses BEFORE export and presents the human approval gate. Do not substitute
a prose confirmation question for the tool call; the runtime owns approval.
Do not claim success if a command failed or a test was not run.`,
})
