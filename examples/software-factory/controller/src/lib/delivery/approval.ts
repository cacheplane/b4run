import { relativePath } from "../domain/path.js"
import type { DraftPrBundlePayload } from "../review/bundle.js"
import { type DeliveryAdapter, DeliveryError } from "./adapter.js"
import { blobId } from "./git-objects.js"
import { FACTORY_BOT_LOGIN, protectedPathsIn, repositoryPath } from "./guard.js"
import type { DeliveryIntent } from "./outbox.js"
import { pullTitle } from "./pr-body.js"
import { scrub } from "./scrub.js"

/**
 * What `approve` checks and commits for a draft-PR bundle (rung 4 spec §3.4), kept out of
 * the factory so each piece is tested on its own. Nothing here writes to GitHub.
 */

/** The configured destination: the controller's, and the only one it delivers to. */
export interface DraftPrConfig {
  readonly repository: string
  readonly baseBranch: string
  readonly adapter: DeliveryAdapter
}

/** The changed paths a delivery may never touch, as repository paths. */
export function protectedChanges(pathPrefix: string, changedPaths: readonly string[]): string[] {
  return protectedPathsIn(changedPaths.map((path) => repositoryPath(pathPrefix, path)))
}

/**
 * Preflight (spec §3.4 item 3, §10.2): a token can be minted for the repository, the app is the
 * one the CI guard skips, and the rulesets that confine it exist. A problem is a refusal, not a
 * block: nothing was committed, and a person can fix the app and approve again in the window.
 * The rulesets' bypass lists cannot be read with the app's token; the scratch lane and the
 * live run check those once.
 */
export async function preflightDelivery(
  adapter: DeliveryAdapter,
  target: { readonly repository: string; readonly baseBranch: string; readonly branch: string },
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const session = await adapter.open(target.repository, signal)
    if (session.botLogin !== FACTORY_BOT_LOGIN)
      return `the app's bot is ${session.botLogin}, but the CI guard skips ${FACTORY_BOT_LOGIN} (controller/src/lib/delivery/guard.json and the workflows): rename one`
    const base = await session.branchRules(target.baseBranch)
    if (!base.includes("update"))
      return `no ruleset restricts updates to ${target.baseBranch}: create "factory app confined" (spec §10.2) before delivering`
    const own = await session.branchRules(target.branch)
    const missing = ["update", "non_fast_forward"].filter((rule) => !own.includes(rule))
    if (missing.length > 0)
      return `the rulesets do not apply ${missing.join(" and ")} to ${target.branch}: create "factory branches are append-never" (spec §10.2)`
    return undefined
  } catch (error) {
    const message =
      error instanceof DeliveryError
        ? `${error.kind}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error)
    return scrub(message, adapter.secrets())
  }
}

/**
 * The outbox intent an approval commits: everything the worker will need, read now from
 * sources the approval just checked (the frozen bundle, the re-captured baseline, the task
 * directory read with the digest it was compared against), so a resumed worker re-reads
 * nothing that could have moved.
 */
export function buildDeliveryIntent(input: {
  readonly workOrderId: string
  readonly bundleDigest: string
  readonly payload: DraftPrBundlePayload
  readonly candidateArtifact: string
  readonly changes: Readonly<Record<string, string>>
  readonly baseline: ReadonlyMap<string, string>
  readonly issueNumber: number
  readonly specText: string
  readonly issueText: string
  readonly approvedAt: string
  readonly decidedBy: string
  readonly reverificationReceiptId: string
}): DeliveryIntent {
  const { payload } = input
  if (payload.taskDigest === null) throw new Error("A draft-PR bundle names no approved task")
  const paths = Object.keys(input.changes)
    .map((workspacePath) => {
      const before = input.baseline.get(workspacePath)
      if (before === undefined)
        throw new Error(`the baseline does not hold ${workspacePath}, which the candidate changes`)
      // The outbox and the worker compare repository paths by string, so each must have one
      // spelling: the prefix is canonical by the bundle's schema, the workspace path is checked
      // here, and the join of two canonical paths is canonical.
      if (!relativePath.safeParse(workspacePath).success)
        throw new Error(`the candidate's ${workspacePath} is not a canonical path`)
      const path = repositoryPath(payload.delivery.pathPrefix, workspacePath)
      if (!relativePath.safeParse(path).success)
        throw new Error(`the repository path ${path} is not a canonical path`)
      return {
        path,
        workspacePath,
        baselineBlob: blobId(before),
        candidateBlob: blobId(input.changes[workspacePath] as string),
      }
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1))
  return {
    version: 1,
    workOrderId: input.workOrderId,
    bundleDigest: input.bundleDigest,
    candidateDigest: payload.candidateDigest,
    candidateArtifact: input.candidateArtifact,
    repository: payload.delivery.repository,
    baseBranch: payload.delivery.baseBranch,
    branch: payload.delivery.branch,
    pin: payload.pin,
    pathPrefix: payload.delivery.pathPrefix,
    issue: { number: input.issueNumber, stateAtCreate: payload.delivery.issueStateAtCreate },
    paths,
    title: pullTitle(input.specText, input.issueText),
    specText: input.specText,
    approvedAt: input.approvedAt,
    decidedBy: input.decidedBy,
    digests: {
      task: payload.taskDigest,
      policy: payload.policyDigest,
      environment: payload.environmentIdentity,
      oracleReceiptId: payload.oracleReceiptId,
      receiptId: payload.receiptId,
      reverificationReceiptId: input.reverificationReceiptId,
    },
  }
}
