import { custom, defineEval, gate, runEval } from "@b4run/evals"
import type { AgentRunResult } from "@b4run/testing"
import { type ReviewCandidate, validateCandidate } from "../../../review/candidate.js"

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
    if (
      typeof args?.command !== "string" ||
      !/^npm[ \t]+(?:--silent[ \t]+)?(?:test|run[ \t]+test)(?:[ \t]+--silent)?$/.test(
        args.command.trim(),
      )
    )
      continue
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

export async function evaluateRun(run: AgentRunResult) {
  return runEval(
    defineEval({
      name: "code-fixer independent verification",
      route: "/fix#agent",
      dataset: [{ name: "attempt", input: "Repair the fixture" }],
      scorers: repairScorers,
      gate: gate.perScorer(),
    }),
    { runCase: async () => run },
  )
}

/** The same six gates drive route evals, replay tests, and maintainer recordings. */
export function repairCriteria(run: AgentRunResult) {
  const result = [...run.toolResults]
    .reverse()
    .find((entry) => entry.name === "prepareReview" && !entry.isError)
  let prepared:
    | {
        verification?: { visible?: { passed?: boolean }; independent?: { passed?: boolean } }
        candidate?: unknown
      }
    | undefined
  try {
    prepared = typeof result?.content === "string" ? JSON.parse(result.content) : result?.content
  } catch {
    // A malformed tool result cannot establish verification.
  }
  const behavior = behaviorCriteria(run)
  let candidate: ReviewCandidate | undefined
  let approval = false
  try {
    candidate = validateCandidate(prepared?.candidate)
    const call = [...run.toolCalls].reverse().find((entry) => entry.name === "exportForReview")
    const pending = validateCandidate(
      (call?.args as { candidate?: unknown } | undefined)?.candidate,
    )
    approval = behavior.approval && pending.receiptDigest === candidate.receiptDigest
  } catch {
    // The approval must name the exact validated candidate returned by preparation.
  }
  return {
    ...behavior,
    approval,
    visible: prepared?.verification?.visible?.passed === true,
    independent: prepared?.verification?.independent?.passed === true,
    scope: Object.keys(candidate?.changes ?? {}).length > 0,
  }
}

export const repairScorers = (
  ["reproduced", "verified", "approval", "visible", "independent", "scope"] as const
).map((name) => custom((run) => repairCriteria(run)[name], { name, threshold: 1 }))
