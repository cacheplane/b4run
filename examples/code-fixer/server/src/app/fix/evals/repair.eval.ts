import { defineEval, gate } from "@b4run/evals"
import { repairScorers } from "./scoring.js"

export const taskInput =
  "Read TASK.md, reproduce the failure, repair the permitted source, verify the preservation requirements, call prepareReview, and then exportForReview with its exact candidate to request runtime approval."

/** Run with b4 eval --live; test:sandbox also exercises the same gates offline. */
export default defineEval({
  name: "code-fixer repair workflow",
  dataset: [{ name: "configured project", input: taskInput }],
  scorers: repairScorers,
  gate: gate.perScorer(),
})
