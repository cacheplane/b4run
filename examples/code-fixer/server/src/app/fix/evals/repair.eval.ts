import { custom, defineEval, gate } from "@b4run/evals"
import { behaviorCriteria } from "../../../evaluation/evaluate.js"
import { taskInput } from "../../../evaluation/replay.js"

/** Run with --live; deterministic two-turn replay uses the separate batch command. */
export default defineEval({
  name: "code-fixer repair workflow",
  dataset: [{ name: "configured fixture", input: taskInput }],
  scorers: [
    ...["reproduced", "verified", "approval"].map((name) =>
      custom((run) => behaviorCriteria(run)[name as "reproduced" | "verified" | "approval"], {
        name,
        threshold: 1,
      }),
    ),
    ...["visible", "independent", "scope"].map((name) =>
      custom(
        (run) => {
          const result = [...run.toolResults]
            .reverse()
            .find((entry) => entry.name === "prepareReview" && !entry.isError)
          if (!result) return false
          const prepared = (
            typeof result.content === "string" ? JSON.parse(result.content) : result.content
          ) as {
            verification?: { visible?: { passed?: boolean }; independent?: { passed?: boolean } }
            candidate?: { changes?: Record<string, string> }
          }
          return name === "scope"
            ? Object.keys(prepared.candidate?.changes ?? {}).length > 0
            : prepared.verification?.[name as "visible" | "independent"]?.passed === true
        },
        { name, threshold: 1 },
      ),
    ),
  ],
  gate: gate.perScorer(),
})
