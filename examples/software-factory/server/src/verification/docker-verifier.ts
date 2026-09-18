import { randomUUID } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { withWorkspace } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import { inspectWorkspace } from "@b4run/workspace"
import type { Receipt } from "../domain/work-order.js"
import { appRoot, loadFixture } from "../fixtures/catalog.js"
import { fixtureWorkspace, sandboxImage, sandboxPolicy } from "../fixtures/workspace.js"
import type { ArtifactStore } from "../storage/artifacts.js"
import { runSuite, type SuiteResult } from "./checks-runner.js"
import { type Verifier, type VerifyInput, worstVerdict } from "./verifier.js"

/**
 * How long one verification may take before the verifier stops itself.
 *
 * The verifier bounds itself rather than trusting a caller to bound it. Today it
 * has no such caller at boot: `reconcileAll` is awaited inside `createFactory`
 * and the budget ticker only starts afterwards, so a verification that runs
 * during reconciliation runs with no budget enforcement, nothing alive to cancel
 * it, and the HTTP API not yet listening. A hang there is a hang of the process.
 *
 * The figure is the sum of what the work can legitimately need: two suites at
 * the policy's 120s per-command ceiling, plus workspace capture, container
 * creation and four inspections.
 */
export const VERIFIER_DEADLINE_MS = 300_000

export interface DockerVerifierOptions {
  /** Overridable only so a test can prove the deadline fires. */
  readonly deadlineMs?: number
}

interface Outcome {
  readonly tampered: "visible" | "independent" | null
  readonly visible: SuiteResult
  readonly independent: SuiteResult | null
}

/**
 * The real verifier. Its container is not the builder's: a different sandbox
 * scope, a freshly captured workspace, and the independent checks written in only
 * after the visible suite has had its turn, from the controller's own copy.
 *
 * The workspace is snapshotted before and after each suite. Any persistent change
 * a suite made is a rejection, which is what catches a candidate that repairs
 * itself by editing its own tests.
 */
export function createDockerVerifier(
  artifacts: ArtifactStore,
  options: DockerVerifierOptions = {},
): Verifier {
  const deadlineMs = options.deadlineMs ?? VERIFIER_DEADLINE_MS
  return {
    async verify(input: VerifyInput, signal: AbortSignal): Promise<Receipt> {
      const fixture = loadFixture(input.taskId)
      const stateRoot = join(appRoot, ".factory", "verifiers", randomUUID())
      const provider = dockerSandbox({ scope: "software-factory-verifier", image: sandboxImage })
      const environmentIdentity = sandboxImage
      // Built at return time, not at entry: `issuedAt` is when the receipt was
      // issued, and a run that took four minutes must not claim it was issued
      // before the checks it reports had run.
      const base = () => ({
        id: `rc-${randomUUID()}`,
        workOrderId: input.workOrderId,
        candidateDigest: input.candidateDigest,
        verifierIdentity: `${provider.name}:${environmentIdentity}`,
        policyDigest: input.policyDigest,
        environmentIdentity,
        issuedAt: new Date().toISOString(),
      })

      // The deadline is ours; the caller's signal is the caller's. Composing them
      // means the container is torn down either way — `withWorkspace` destroys the
      // thread on a fresh signal in its `finally` — while leaving the two causes
      // distinguishable afterwards.
      const deadline = AbortSignal.timeout(deadlineMs)
      const bounded = AbortSignal.any([signal, deadline])

      let outcome: Outcome
      try {
        outcome = await withWorkspace(
          {
            appRoot,
            stateRoot,
            provider,
            workspace: fixtureWorkspace(input.taskId),
            policy: sandboxPolicy,
            signal: bounded,
          },
          async (handle) => {
            const snapshot = async () =>
              (
                await inspectWorkspace(handle, {
                  signal: bounded,
                  maxEntries: 1000,
                  maxFileBytes: 2 * 1024 * 1024,
                  maxTotalBytes: 2 * 1024 * 1024,
                  excludeRootDirectories: [".git"],
                  expectedRootSymlinks: {
                    node_modules: `/opt/fixtures/${input.taskId}/node_modules`,
                  },
                })
              ).files

            for (const [path, content] of Object.entries(input.changes))
              await handle.filesystem.writeFile(join(handle.workspaceRoot, path), content, {
                workspaceRoot: handle.workspaceRoot,
                signal: bounded,
              })

            const beforeVisible = await snapshot()
            const visible = await runSuite(handle, fixture.checks.visible, bounded)
            if (changed(beforeVisible, await snapshot()))
              return { tampered: "visible" as const, visible, independent: null }

            // Installed here and not before: the visible suite must not be able to
            // read, edit or delete the checks it is graded against a moment later.
            const name = fixture.checks.independent.file.replace(/^checks\//, "")
            await handle.filesystem.writeFile(
              join(handle.workspaceRoot, "checks", name),
              await readFile(join(fixture.directory, "checks", name), "utf8"),
              { workspaceRoot: handle.workspaceRoot, signal: bounded },
            )

            const beforeIndependent = await snapshot()
            const independent = await runSuite(handle, fixture.checks.independent, bounded)
            if (changed(beforeIndependent, await snapshot()))
              return { tampered: "independent" as const, visible, independent }

            return { tampered: null, visible, independent }
          },
        )
      } catch (error) {
        // Our own deadline fired: the harness ran out of time, which is a fact
        // about the harness and not about the candidate. That is exactly what
        // `inconclusive` means, so it is a receipt and not a rejection. A caller
        // cancel is the caller's own decision and is re-thrown untouched.
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
                await put(artifacts, `verification exceeded its ${deadlineMs}ms deadline`),
              ],
            },
          ],
        }
      } finally {
        await rm(stateRoot, { recursive: true, force: true })
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
                  `a suite mutated the workspace during ${outcome.tampered}\n${outcome.visible.output}`,
                ),
              ],
            },
          ],
        }

      const independent = outcome.independent
      if (!independent) throw new Error("independent suite did not run and no tamper was recorded")

      return {
        ...base(),
        verdict: worstVerdict([outcome.visible.verdict, independent.verdict]),
        checks: [
          {
            id: "visible",
            acceptanceIds: fixture.checks.visible.assertions,
            verdict: outcome.visible.verdict,
            evidence: [await put(artifacts, outcome.visible.output)],
          },
          {
            id: "independent",
            acceptanceIds: fixture.checks.independent.assertions,
            verdict: independent.verdict,
            evidence: [await put(artifacts, independent.output)],
          },
        ],
      }
    },
  }
}

/**
 * Any persistent difference at all, compared over sorted entries so that a change
 * of key ORDER in an inspection result can never be mistaken for a mutation.
 */
const changed = (
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): boolean => JSON.stringify(sorted(before)) !== JSON.stringify(sorted(after))

const sorted = (files: Readonly<Record<string, string>>): [string, string][] =>
  Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

async function put(artifacts: ArtifactStore, content: string) {
  const ref = await artifacts.put(content === "" ? "(no output)\n" : content)
  return { id: "output", digest: ref.digest }
}
