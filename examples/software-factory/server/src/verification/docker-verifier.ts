import { randomUUID } from "node:crypto"
import { dockerSandbox } from "@b4run/sandbox"
import type { Receipt } from "../domain/work-order.js"
import type { ArtifactStore } from "../storage/artifacts.js"
import { environmentIdentity, imageTag, loadTask } from "../targets/catalog.js"
import { gradeSuite, type SuiteSession } from "./grade-suite.js"
import { type Verifier, type VerifyInput, worstVerdict } from "./verifier.js"

export interface DockerVerifierOptions {
  /** Overrides the target's own deadline; only so a test can prove the deadline fires. */
  readonly deadlineMs?: number
}

/**
 * The real verifier. Its containers are not the builder's: a different sandbox scope and
 * freshly captured workspaces of its own.
 *
 * Each suite is graded in a container that only it ran in — two full sessions, each with its
 * own capture, build and workspace snapshots. The oracle is therefore graded where the
 * candidate's test code has never run, which is the RFC's separate-trusted-process
 * recommendation applied to the one place the dogfood found it mattered. {@link gradeSuite}
 * carries the reasoning.
 *
 * Within a session the workspace is snapshotted before and after the suite. Any persistent
 * change the suite made is a rejection, which is what catches a candidate that repairs itself
 * by editing its own tests.
 */
export function createDockerVerifier(
  artifacts: ArtifactStore,
  options: DockerVerifierOptions = {},
): Verifier {
  return {
    async verify(input: VerifyInput, signal: AbortSignal): Promise<Receipt> {
      const task = loadTask(input.taskId)
      const target = task.target
      const deadlineMs = options.deadlineMs ?? target.resources.verifierDeadlineMs
      const provider = dockerSandbox({
        scope: "software-factory-verifier",
        image: imageTag(target),
      })
      const identity = environmentIdentity(target)
      // Built at return time, not at entry: `issuedAt` is when the receipt was issued, and a
      // run that took four minutes must not claim it was issued before the checks it
      // reports had run.
      const base = () => ({
        id: `rc-${randomUUID()}`,
        workOrderId: input.workOrderId,
        candidateDigest: input.candidateDigest,
        verifierIdentity: `${provider.name}:${identity}`,
        policyDigest: input.policyDigest,
        environmentIdentity: identity,
        issuedAt: new Date().toISOString(),
      })

      // The deadline is ours; the caller's signal is the caller's. Composing them means the
      // container is torn down either way while leaving the two causes distinguishable. It is
      // created once, before the first session, so it bounds the whole verification rather
      // than granting each session a fresh budget.
      const deadline = AbortSignal.timeout(deadlineMs)
      const bounded = AbortSignal.any([signal, deadline])
      const session = (kind: "visible" | "independent") =>
        gradeSuite({ task, kind, changes: input.changes, provider, signal: bounded })

      let visible: SuiteSession
      let independent: SuiteSession | null = null
      try {
        visible = await session("visible")
        // A failed build or a tamper is already the whole verdict: the second container would
        // cost a capture, a start and a build to report a receipt that is already decided.
        if (visible.build.ok && !visible.tampered) independent = await session("independent")
      } catch (error) {
        // Our own deadline fired: a fact about the harness, not the candidate. That is what
        // `inconclusive` means, so it is a receipt and not a rejection. A caller cancel is
        // the caller's own decision and is re-thrown untouched.
        if (!deadline.aborted || signal.aborted) throw error
        return {
          ...base(),
          verdict: "inconclusive",
          checks: [
            {
              id: "deadline",
              acceptanceIds: [],
              verdict: "inconclusive",
              evidence: [
                await put(
                  artifacts,
                  "deadline",
                  `verification exceeded its ${deadlineMs}ms deadline`,
                ),
              ],
            },
          ],
        }
      }

      if (!visible.build.ok)
        return {
          ...base(),
          verdict: "fail",
          checks: [
            {
              id: "build",
              acceptanceIds: [],
              verdict: "fail",
              evidence: [await put(artifacts, "build", visible.build.output)],
            },
          ],
        }

      if (visible.tampered) return await tamperReceipt(artifacts, base(), "visible", visible)
      if (!independent)
        throw new Error("the independent session did not run and no verdict was recorded")

      // The same build, from the same bytes, already succeeded in the visible session. If it
      // fails here the two containers disagreed, which is a fact about the harness and not
      // about the candidate — `inconclusive`, never `fail`. Grading it as a failure would let
      // a flaky compiler reject a correct repair.
      if (!independent.build.ok)
        return {
          ...base(),
          verdict: "inconclusive",
          checks: [
            {
              id: "build",
              acceptanceIds: [],
              verdict: "inconclusive",
              evidence: [
                await put(
                  artifacts,
                  "build",
                  `the build succeeded in the visible session and failed in the independent one\n${independent.build.output}`,
                ),
              ],
            },
          ],
        }

      if (independent.tampered)
        return await tamperReceipt(artifacts, base(), "independent", independent)

      const visibleResult = visible.result
      const independentResult = independent.result
      if (!visibleResult || !independentResult)
        throw new Error("a suite did not run and neither a build failure nor a tamper was recorded")

      return {
        ...base(),
        verdict: worstVerdict([visibleResult.verdict, independentResult.verdict]),
        checks: suiteChecks({
          visible: {
            verdict: visibleResult.verdict,
            acceptanceIds: task.checks.visible.assertions,
            outputDigest: (await put(artifacts, "visible", visibleResult.output)).digest,
          },
          independent: {
            verdict: independentResult.verdict,
            acceptanceIds: task.checks.independent.assertions,
            outputDigest: (await put(artifacts, "independent", independentResult.output)).digest,
          },
        }),
      }
    },
  }
}

/** The receipt a tampering candidate gets: one check, named for the session it happened in. */
async function tamperReceipt(
  artifacts: ArtifactStore,
  base: Omit<Receipt, "verdict" | "checks">,
  kind: "visible" | "independent",
  session: SuiteSession,
): Promise<Receipt> {
  return {
    ...base,
    verdict: "fail",
    checks: [
      {
        id: kind,
        acceptanceIds: [],
        verdict: "fail",
        evidence: [
          await put(
            artifacts,
            kind,
            `a suite mutated the workspace during ${kind}\n${session.result?.output ?? ""}`,
          ),
        ],
      },
    ],
  }
}

/**
 * Store one check's output and name the reference after the check that produced it.
 *
 * The id must be unique per check, not per kind of artifact: `freezeBundle` folds the
 * receipt's evidence into one set keyed by id and refuses a receipt that names the same id
 * with two digests. A shared `"output"` id therefore made every real passing receipt
 * unfreezable — two checks, two outputs, one id — and the failure surfaced only as
 * `verification_inconclusive` from the phase's backstop.
 */
async function put(artifacts: ArtifactStore, checkId: string, content: string) {
  const ref = await artifacts.put(content === "" ? "(no output)\n" : content)
  return evidenceRef(checkId, ref.digest)
}

/** The one place an evidence id is formed, so every check's reference is distinct by shape. */
export function evidenceRef(checkId: string, digest: string): { id: string; digest: string } {
  return { id: `${checkId}/output`, digest }
}

/**
 * The checks a passing or failing run of both suites reports, in the receipt's own order.
 *
 * Exported because it is the shape `freezeBundle` has to accept: a test that builds a
 * receipt by hand proves nothing about the receipt this verifier emits, and the Docker lane
 * is not always on. Layer 1 calls this and freezes the result.
 */
export function suiteChecks(input: {
  readonly visible: SuiteEvidence
  readonly independent: SuiteEvidence
}): Receipt["checks"] {
  return [
    {
      id: "visible",
      acceptanceIds: [...input.visible.acceptanceIds],
      verdict: input.visible.verdict,
      evidence: [evidenceRef("visible", input.visible.outputDigest)],
    },
    {
      id: "independent",
      acceptanceIds: [...input.independent.acceptanceIds],
      verdict: input.independent.verdict,
      evidence: [evidenceRef("independent", input.independent.outputDigest)],
    },
  ]
}

/** One suite's contribution to a receipt: its verdict, what it graded, and its output. */
export interface SuiteEvidence {
  readonly verdict: Receipt["verdict"]
  readonly acceptanceIds: readonly string[]
  readonly outputDigest: string
}
