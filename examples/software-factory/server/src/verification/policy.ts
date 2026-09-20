import { createHash } from "node:crypto"
import { type PolicyEnvironment, policyDigest, specificationDigest } from "../domain/digest.js"
import { type Checks, environmentIdentity, loadTask, type Task } from "../targets/catalog.js"

export interface VerificationPolicy {
  readonly taskId: string
  readonly task: Task
  readonly checks: Checks
  readonly allowedSourcePaths: readonly string[]
  readonly immutablePaths: readonly string[]
  /** The named assertions across both suites: the acceptance criteria. */
  readonly acceptanceIds: readonly string[]
  readonly environment: PolicyEnvironment
  readonly specificationDigest: string
  readonly policyDigest: string
}

/** What the verdict is earned in and over: the target's identity and the baseline's definition. */
export function policyEnvironment(task: Task): PolicyEnvironment {
  return {
    identity: environmentIdentity(task.target),
    pin: task.target.pin,
    root: task.target.root,
    captureInclude: task.target.capture.include,
    defectPatchSha256:
      task.defectPatch === null
        ? null
        : createHash("sha256").update(task.defectPatch).digest("hex"),
  }
}

/** The completion policy, derived from catalog data the controller owns. */
export function loadPolicy(taskId: string): VerificationPolicy {
  const task = loadTask(taskId)
  const acceptanceIds = [...task.checks.visible.assertions, ...task.checks.independent.assertions]
  const environment = policyEnvironment(task)
  return {
    taskId,
    task,
    checks: task.checks,
    allowedSourcePaths: task.manifest.allowedSourcePaths,
    immutablePaths: task.manifest.immutablePaths,
    acceptanceIds,
    environment,
    specificationDigest: specificationDigest(task.specText, acceptanceIds),
    policyDigest: policyDigest({
      checks: task.checks,
      allowedSourcePaths: task.manifest.allowedSourcePaths,
      immutablePaths: task.manifest.immutablePaths,
      environment,
    }),
  }
}
