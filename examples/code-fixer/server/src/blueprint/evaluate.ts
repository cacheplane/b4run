import { custom, defineEval, gate, runEval } from "@b4run/evals"
import type { AgentRunResult } from "@b4run/testing"

export function behaviorCriteria(run: AgentRunResult) {
  const firstEdit = run.toolCalls.findIndex((call) => call.name === "writeFile")
  const results = run.toolResults.filter((result) => result.name === "runBash")
  let commandIndex = 0
  let reproduced = false
  let verified = false
  for (const [index, call] of run.toolCalls.entries()) {
    if (call.name !== "runBash") continue
    const result = results[commandIndex++]
    if (!result || result.isError) continue
    const args = call.args as { command?: unknown } | null
    if (args?.command !== "npm test") continue
    let content = result.content
    if (typeof content === "string") {
      try {
        content = JSON.parse(content)
      } catch {
        continue
      }
    }
    const exitCode = (content as { exitCode?: unknown } | null)?.exitCode
    if (typeof exitCode !== "number" || firstEdit < 0) continue
    if (index < firstEdit && exitCode !== 0) reproduced = true
    if (index > firstEdit && exitCode === 0) verified = true
  }
  const approval =
    run.interrupts.length === 1 &&
    run.interrupts[0]?.kind === "tool" &&
    run.interrupts[0].detail.toolName === "exportForReview" &&
    !run.toolResults.some((result) => result.name === "exportForReview")
  return { reproduced, verified, approval }
}

export async function evaluateRun(run: AgentRunResult, criteria: Record<string, boolean>) {
  return runEval(
    defineEval({
      name: "code-fixer independent verification",
      route: "/fix#agent",
      dataset: [{ name: "attempt", input: "Repair the fixture" }],
      scorers: Object.entries(criteria).map(([name, passed]) =>
        custom(() => passed, { name, threshold: 1 }),
      ),
      gate: gate.perScorer(),
    }),
    { runCase: async () => run },
  )
}
