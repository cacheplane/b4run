import { randomUUID } from "node:crypto"
import { dockerSandbox } from "@b4run/sandbox"
import type { Receipt } from "../domain/work-order.js"
import type { ArtifactStore } from "../storage/artifacts.js"
import { environmentIdentity, imageTag, loadTask } from "../targets/catalog.js"
import { gradeSuite, type SuiteKind, type SuiteSession } from "./grade-suite.js"
import { assembleReceipt, deadlinePlan, evidenceRef, type ReceiptPlan } from "./receipt.js"
import type { Verifier, VerifyInput } from "./verifier.js"

export interface DockerVerifierOptions {
  /**
   * Where each session stages its capture and workspace state (see
   * `GradeSuiteInput.stagingRoot`): the controller's `FACTORY_STATE_DIR`, never its app root.
   */
  readonly stagingRoot: string
  /** Overrides the target's own deadline; only so a test can prove the deadline fires. */
  readonly deadlineMs?: number
}

/**
 * The real verifier. Its containers are not the builder's: a different sandbox scope and
 * freshly captured workspaces of its own.
 *
 * Each suite is graded in a container that only it ran in — two full sessions in `full` mode,
 * one in `independentOnly`, each with its own capture, build and workspace snapshots. The
 * oracle is therefore graded where the visible suite's test code has never run, which is the
 * RFC's separate-trusted-process recommendation applied to the one place the dogfood found it
 * mattered. {@link gradeSuite} carries the reasoning, including what this does and does not
 * remove from the independent session. Intake's independent-only session is its own container
 * too, and intake passes no changes, so the same reasoning holds there.
 *
 * Within a session the workspace is snapshotted before and after the suite. Any persistent
 * change the suite made is a rejection, which is what catches a candidate that repairs itself
 * by editing its own tests.
 *
 * This function runs the containers and stores the evidence. Deciding the verdict is
 * {@link assembleReceipt}, which is pure over the two sessions' outcomes and is where layer 1
 * covers the branches two disagreeing containers would be needed to reach.
 */
export function createDockerVerifier(
  artifacts: ArtifactStore,
  options: DockerVerifierOptions,
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

      /**
       * Store each check's evidence and name the reference after the check that produced it,
       * then seal the receipt.
       *
       * The evidence id must be unique per check, not per kind of artifact: `freezeBundle`
       * folds a receipt's evidence into one set keyed by id and refuses a receipt that names
       * the same id with two digests. A shared `"output"` id therefore made every real passing
       * receipt unfreezable — two checks, two outputs, one id — and the failure surfaced only
       * as `verification_inconclusive` from the phase's backstop.
       *
       * `issuedAt` is read here and not at entry: a run that took four minutes must not claim
       * it was issued before the checks it reports had run.
       */
      const seal = async (plan: ReceiptPlan): Promise<Receipt> => ({
        id: `rc-${randomUUID()}`,
        workOrderId: input.workOrderId,
        candidateDigest: input.candidateDigest,
        verifierIdentity: `${provider.name}:${identity}`,
        policyDigest: input.policyDigest,
        environmentIdentity: identity,
        issuedAt: new Date().toISOString(),
        verdict: plan.verdict,
        checks: await Promise.all(
          plan.checks.map(async (check) => {
            const ref = await artifacts.put(
              check.evidence === "" ? "(no output)\n" : check.evidence,
            )
            return {
              id: check.id,
              acceptanceIds: [...check.acceptanceIds],
              verdict: check.verdict,
              evidence: [evidenceRef(check.id, ref.digest)],
            }
          }),
        ),
      })

      // The deadline is ours; the caller's signal is the caller's. Composing them means the
      // container is torn down either way while leaving the two causes distinguishable. It is
      // created once, before the first session, so it bounds the whole verification rather
      // than granting each session a fresh budget.
      const deadline = AbortSignal.timeout(deadlineMs)
      const bounded = AbortSignal.any([signal, deadline])
      const session = (kind: SuiteKind) =>
        gradeSuite({
          task,
          kind,
          changes: input.changes,
          provider,
          signal: bounded,
          stagingRoot: options.stagingRoot,
        })

      const mode = input.mode ?? "full"
      let visible: SuiteSession | null = null
      let independent: SuiteSession | null = null
      try {
        if (mode === "independentOnly") {
          independent = await session("independent")
        } else {
          visible = await session("visible")
          // A failed build or a tamper is already the whole verdict: the second container
          // would cost a capture, a start and a build to report a receipt that is already
          // decided.
          if (visible.build.ok && !visible.tampered) independent = await session("independent")
        }
      } catch (error) {
        // Our own deadline fired: a fact about the harness, not the candidate. That is what
        // `inconclusive` means, so it is a receipt and not a rejection. A caller cancel is
        // the caller's own decision and is re-thrown untouched.
        if (!deadline.aborted || signal.aborted) throw error
        return await seal(deadlinePlan(deadlineMs))
      }

      return await seal(
        assembleReceipt({
          visible,
          independent,
          mode,
          acceptanceIds: {
            visible: task.checks.visible.assertions,
            independent: task.checks.independent.assertions,
          },
        }),
      )
    },
  }
}
