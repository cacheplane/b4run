import { policyDigest, specificationDigest } from "../domain/digest.js"
import { type Checks, loadFixture } from "../fixtures/catalog.js"

export interface VerificationPolicy {
  readonly taskId: string
  readonly checks: Checks
  readonly allowedSourcePaths: readonly string[]
  readonly immutablePaths: readonly string[]
  /** The named assertions across both suites. Rung 1's acceptance criteria. */
  readonly acceptanceIds: readonly string[]
  readonly specificationDigest: string
  readonly policyDigest: string
}

/** The completion policy, derived from fixture data the controller owns. */
export function loadPolicy(taskId: string): VerificationPolicy {
  const fixture = loadFixture(taskId)
  const acceptanceIds = [
    ...fixture.checks.visible.assertions,
    ...fixture.checks.independent.assertions,
  ]
  return {
    taskId,
    checks: fixture.checks,
    allowedSourcePaths: fixture.manifest.allowedSourcePaths,
    immutablePaths: fixture.manifest.immutablePaths,
    acceptanceIds,
    specificationDigest: specificationDigest(fixture.taskText, acceptanceIds),
    policyDigest: policyDigest({
      checks: fixture.checks,
      allowedSourcePaths: fixture.manifest.allowedSourcePaths,
      immutablePaths: fixture.manifest.immutablePaths,
      // Rung 1 has no target catalog yet; a later task derives this from the task's target.
      environment: {
        identity: "fixture",
        pin: "0".repeat(40),
        root: ".",
        captureInclude: [],
        defectPatchSha256: null,
      },
    }),
  }
}
