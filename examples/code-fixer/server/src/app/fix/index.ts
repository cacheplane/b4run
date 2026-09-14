import { agent } from "@b4run/sdk"

export default agent({
  model: process.env.B4_CODE_FIXER_MODEL ?? "gpt-5-mini",
  recursionLimit: 60,
  description: "Repairs a failing test and verifies the change.",
  tools: { approve: ["exportForReview"] },
  systemPrompt: `You fix a focused code defect in the workspace project.
Read TASK.md and the verify-change skill. Reproduce the failure with npm test
before editing. Inspect the relevant source and make the smallest correct fix.
Use readFile, listDir, writeFile, and runBash. Never change tests, configuration,
dependencies, or files outside the source paths specified in TASK.md.
Run npm test after the change. Explain what changed and what actually passed.
Then request exportForReview; a human controls exporting the verified patch.
Do not claim success if a command failed or a test was not run.`,
})
