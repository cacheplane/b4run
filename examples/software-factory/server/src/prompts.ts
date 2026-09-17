/** The single worker turn per task id: produce, verify, and request export approval. */
export const TASK_PROMPTS: Readonly<Record<string, string>> = {
  "cli-flags":
    "Read TASK.md, reproduce the failure, repair the permitted source, verify the preservation requirements, call prepareReview, and then exportForReview with its exact candidate to request runtime approval.",
}
