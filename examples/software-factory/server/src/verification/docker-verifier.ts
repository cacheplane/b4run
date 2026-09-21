import { randomUUID } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { withWorkspace } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import { inspectWorkspace } from "@b4run/workspace"
import type { Receipt } from "../domain/work-order.js"
import type { ArtifactStore } from "../storage/artifacts.js"
import { captureDirectory } from "../targets/archive.js"
import { appRoot, environmentIdentity, imageTag, loadTask } from "../targets/catalog.js"
import {
  targetInspectionOptions,
  targetSandboxPolicy,
  targetWorkspace,
} from "../targets/workspace.js"
import { runBuild, runSuite, type SuiteResult } from "./checks-runner.js"
import { type Verifier, type VerifyInput, worstVerdict } from "./verifier.js"

export interface DockerVerifierOptions {
  /** Overrides the target's own deadline; only so a test can prove the deadline fires. */
  readonly deadlineMs?: number
}

interface Outcome {
  readonly build: { ok: boolean; output: string }
  readonly tampered: "visible" | "independent" | null
  readonly visible: SuiteResult | null
  readonly independent: SuiteResult | null
}

/**
 * The real verifier. Its container is not the builder's: a different sandbox scope, a
 * freshly captured workspace of its own, and the independent checks written in only after
 * the visible suite has had its turn, from the controller's own copy.
 *
 * The workspace is snapshotted before and after each suite. Any persistent change a suite
 * made is a rejection, which is what catches a candidate that repairs itself by editing its
 * own tests.
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
      const stateRoot = join(appRoot, ".factory", "verifiers", randomUUID())
      // Per-call capture: two work orders on one task may verify concurrently.
      const instance = randomUUID()
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
      // container is torn down either way while leaving the two causes distinguishable.
      const deadline = AbortSignal.timeout(deadlineMs)
      const bounded = AbortSignal.any([signal, deadline])
      const inspection = targetInspectionOptions(task)

      let outcome: Outcome
      try {
        const workspace = targetWorkspace(task, "verifier", { instance })
        outcome = await withWorkspace(
          {
            appRoot,
            stateRoot,
            provider,
            workspace,
            policy: targetSandboxPolicy(target),
            signal: bounded,
          },
          async (handle) => {
            const snapshot = async () =>
              (
                await inspectWorkspace(handle, {
                  signal: bounded,
                  // The framework's defaults, restated so a change there is visible here;
                  // the reader's options spread after them so a target that raises the
                  // reader's limits raises these too.
                  maxEntries: 10_000,
                  maxFileBytes: 2 * 1024 * 1024,
                  maxTotalBytes: 16 * 1024 * 1024,
                  // The reader's own options, spread whole rather than picked apart: a new
                  // one (`runAsNonRoot` today) must not be silently dropped here.
                  // `ignorePrefixes` rides along and is deliberately NOT honoured by this
                  // snapshot: it is reader-side, where build output must not read as an added
                  // candidate path, whereas the tamper comparison below wants to see
                  // everything the walk found. The framework ignores keys it does not know,
                  // so passing it here is inert rather than wrong.
                  ...inspection,
                })
              ).files

            for (const [path, content] of Object.entries(input.changes))
              await handle.filesystem.writeFile(join(handle.workspaceRoot, path), content, {
                workspaceRoot: handle.workspaceRoot,
                signal: bounded,
              })

            const build = await runBuild(handle, target, bounded)
            if (!build.ok) return { build, tampered: null, visible: null, independent: null }

            const beforeVisible = await snapshot()
            const visible = await runSuite(handle, target, task.checks.visible, bounded)
            if (changedDuringSuite(beforeVisible, await snapshot()))
              return { build, tampered: "visible" as const, visible, independent: null }

            // Installed here and not before: the visible suite must not be able to read,
            // edit or delete the checks it is graded against a moment later.
            const name = task.checks.independent.file.replace(/^checks\//, "")
            await handle.filesystem.writeFile(
              join(handle.workspaceRoot, "checks", name),
              await readFile(join(task.directory, "checks", name), "utf8"),
              { workspaceRoot: handle.workspaceRoot, signal: bounded },
            )

            const beforeIndependent = await snapshot()
            const independent = await runSuite(handle, target, task.checks.independent, bounded)
            if (changedDuringSuite(beforeIndependent, await snapshot()))
              return { build, tampered: "independent" as const, visible, independent }

            return { build, tampered: null, visible, independent }
          },
        )
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
      } finally {
        // `allSettled`, and neither awaited alone: a cleanup that fails must not replace the
        // verdict (or the caller's own cancellation) with its own error. The capture is
        // removed only once `withWorkspace` has returned, because the framework captures the
        // source at workspace preparation and does not read it after the callback ends.
        await Promise.allSettled([
          rm(stateRoot, { recursive: true, force: true }),
          rm(join(appRoot, captureDirectory(task.id, "verifier", instance)), {
            recursive: true,
            force: true,
          }),
        ])
      }

      if (!outcome.build.ok)
        return {
          ...base(),
          verdict: "fail",
          checks: [
            {
              id: "build",
              acceptanceIds: [],
              verdict: "fail",
              evidence: [await put(artifacts, "build", outcome.build.output)],
            },
          ],
        }

      if (outcome.tampered)
        return {
          ...base(),
          verdict: "fail",
          checks: [
            {
              id: outcome.tampered,
              acceptanceIds: [],
              verdict: "fail",
              evidence: [
                await put(
                  artifacts,
                  outcome.tampered,
                  `a suite mutated the workspace during ${outcome.tampered}\n${outcome[outcome.tampered]?.output ?? ""}`,
                ),
              ],
            },
          ],
        }

      const visible = outcome.visible
      const independent = outcome.independent
      if (!visible || !independent)
        throw new Error("a suite did not run and neither a build failure nor a tamper was recorded")

      return {
        ...base(),
        verdict: worstVerdict([visible.verdict, independent.verdict]),
        checks: suiteChecks({
          visible: {
            verdict: visible.verdict,
            acceptanceIds: task.checks.visible.assertions,
            outputDigest: (await put(artifacts, "visible", visible.output)).digest,
          },
          independent: {
            verdict: independent.verdict,
            acceptanceIds: task.checks.independent.assertions,
            outputDigest: (await put(artifacts, "independent", independent.output)).digest,
          },
        }),
      }
    },
  }
}

/**
 * Any persistent difference at all between two snapshots, compared over sorted entries.
 *
 * Nothing is excluded, and the target's `snapshotIgnore` in particular is not consulted here.
 * The build completes before the first snapshot is taken, so any change under the target's
 * build output while a suite runs is a suite writing where it must not — and the independent
 * oracle reads that very directory (for `devkit`, the built
 * `packages/devkit/dist/testing/index.js`). An exclusion here would therefore blind the tamper
 * check to exactly the bytes it exists to protect: a candidate whose source is imported by the
 * visible suite can leave a detached process behind that rewrites the artifact between the two
 * snapshots and chooses its own verdict.
 *
 * `snapshotIgnore` keeps its other two consumers — the workspace's `.gitignore` and the
 * reader's `ignorePrefixes`, where build output legitimately must not read as a candidate path.
 */
export function changedDuringSuite(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): boolean {
  const sorted = (files: Readonly<Record<string, string>>): [string, string][] =>
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify(sorted(before)) !== JSON.stringify(sorted(after))
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
