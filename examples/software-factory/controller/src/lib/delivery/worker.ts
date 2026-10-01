import type { BlockedReason, TransitionEvent } from "../domain/states.js"
import type { WorkOrderRow } from "../domain/work-order.js"
import type { WorkOrderPatch, WorkOrderStore } from "../registry/work-orders.js"
import type { ArtifactStore } from "../storage/artifacts.js"
import { type DeliveryAdapter, DeliveryError, type DeliverySession } from "./adapter.js"
import { blobId, changedTreeId, readPinListings } from "./git-objects.js"
import { isRunFromBranchPath, protectedPathsIn } from "./guard.js"
import type { DeliveryRemote, OutboxRow, OutboxStep, OutboxStore } from "./outbox.js"
import { commitMessage, pullBody } from "./pr-body.js"
import { scrub } from "./scrub.js"

/**
 * The delivery worker (rung 4 spec §5.2): advances one work order's outbox intent through
 * idempotent steps, each of which reads remote state before it writes and records what it
 * observed with the step advanced, in one registry transaction. A lost response, a crash or a
 * restart therefore converges on the one branch and the one pull request that exist. The
 * work order is `delivered` only after the pull request is read back and its head commit's
 * tree is exactly the approved tree; anything the worker cannot reconcile is recorded as a
 * blocked reason, never retried blindly.
 */

/** The worker's bound (spec §6.5, §15 item 6). */
export interface DeliveryLimits {
  /** Attempts of one step before a transient or rate-limited failure blocks. */
  readonly attemptsPerStep: number
  /** The longest single wait, whatever the server asked for. */
  readonly maxWaitMs: number
  /** The whole run's bound, from the first request. */
  readonly runMs: number
  /** The first transient backoff; doubled per attempt. */
  readonly backoffStartMs: number
}
export const DEFAULT_DELIVERY_LIMITS: DeliveryLimits = Object.freeze({
  attemptsPerStep: 5,
  maxWaitMs: 60_000,
  runMs: 600_000,
  backoffStartMs: 2_000,
})

export interface DeliveryWorkerDeps {
  readonly adapter: DeliveryAdapter
  readonly limits: DeliveryLimits
  /** Resolves after `ms`, or early when `signal` aborts. Tests record the waits instead. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  /** Wall clock for the run bound; never the factory's injected `now`. */
  readonly clock: () => number
}

/** What the worker needs from the factory; `ControllerContext` provides all of it. */
export interface DeliveryContext {
  readonly store: WorkOrderStore
  readonly outbox: OutboxStore
  readonly artifacts: Pick<ArtifactStore, "read">
  readonly signal: AbortSignal
  iso(): string
  mustGet(id: string): WorkOrderRow
  recordEvent(id: string, type: string, payload?: Record<string, unknown>): void
  transition(
    id: string,
    event: TransitionEvent,
    patch?: WorkOrderPatch,
    payload?: Record<string, unknown>,
  ): WorkOrderRow
}

/** A refusal: the work order blocks with `reason`, and nothing is retried. */
class Stop extends Error {
  constructor(
    readonly reason: BlockedReason,
    readonly detail: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail)
    this.name = "Stop"
  }
}

/** The row left `delivering` (a cancel): stop before the next write. */
class Halted extends Error {}

const sameParents = (parents: readonly string[], pin: string) =>
  parents.length === 1 && parents[0] === pin

export async function runDelivery(
  ctx: DeliveryContext,
  deps: DeliveryWorkerDeps,
  id: string,
): Promise<void> {
  const started = deps.clock()
  const secrets = () => deps.adapter.secrets()
  const first = ctx.outbox.get(id)
  if (first === null) {
    refuse(new Stop("delivery_unconfirmed", "a delivering work order with no outbox intent"))
    return
  }
  const { intent } = first

  /** Before every write and every recorded step: a cancel stops the worker there. */
  const ensureDelivering = () => {
    if (ctx.mustGet(id).state !== "delivering") throw new Halted()
  }

  /**
   * Run one step, retrying it whole (it reads before it writes) on a transient failure or a
   * rate limit, within the step's attempts and the run's bound.
   */
  async function attempt<T>(step: string, run: () => Promise<T>): Promise<T> {
    for (let n = 1; ; n += 1) {
      try {
        return await run()
      } catch (error) {
        // A controller closing mid-request aborts the request: that is a stop, not a failure,
        // and the row stays `delivering` for the next boot's reconcile to resume.
        if (ctx.signal.aborted) throw new Halted()
        if (!(error instanceof DeliveryError)) throw error
        const message = scrub(`${step}: ${error.message}`, secrets())
        if (error.kind === "unauthorized") throw new Stop("delivery_unauthorized", message)
        if (error.kind !== "rate_limited" && error.kind !== "transient")
          throw new Stop("delivery_unconfirmed", message, { status: error.status ?? null })
        const wait =
          error.kind === "rate_limited"
            ? Math.min(error.retryAfterMs ?? deps.limits.backoffStartMs, deps.limits.maxWaitMs)
            : Math.min(deps.limits.backoffStartMs * 2 ** (n - 1), deps.limits.maxWaitMs)
        const outOfTime = deps.clock() - started + wait > deps.limits.runMs
        ctx.outbox.note(id, message, ctx.iso())
        ctx.recordEvent(id, "delivery_retry", {
          step,
          attempt: n,
          kind: error.kind,
          waitMs: wait,
          detail: message,
        })
        if (n >= deps.limits.attemptsPerStep || outOfTime)
          throw new Stop(
            error.kind === "rate_limited" ? "delivery_rate_limited" : "delivery_unconfirmed",
            `${message} (after ${n} attempt(s))`,
          )
        await deps.sleep(wait, ctx.signal)
        if (ctx.signal.aborted) throw new Halted()
      }
    }
  }

  /**
   * Record one step's observation and advance, in one transaction, or (the row moved)
   * journal what exists remotely and report false.
   */
  function record(from: OutboxStep, to: OutboxStep, remote: DeliveryRemote, event: string) {
    return ctx.store.transaction(() => {
      const state = ctx.mustGet(id).state
      if (state !== "delivering") {
        ctx.recordEvent(id, "delivery_stopped", { state, step: from, observed: remote })
        return false
      }
      const row = ctx.outbox.advance(id, from, to, remote, ctx.iso())
      ctx.recordEvent(id, event, { ...remote })
      ctx.outbox.note(id, null, ctx.iso())
      return row.step === to
    })
  }

  function refuse(stop: Stop): void {
    const detail = scrub(stop.detail, secrets())
    ctx.store.transaction(() => {
      if (ctx.outbox.get(id) !== null) ctx.outbox.note(id, detail, ctx.iso())
      ctx.recordEvent(id, "delivery_refused", {
        reason: stop.reason,
        detail,
        ...stop.extra,
        remote: ctx.outbox.get(id)?.remote ?? {},
      })
      if (ctx.mustGet(id).state === "delivering")
        ctx.transition(
          id,
          "delivery_refused",
          { blockedReason: stop.reason },
          { reason: stop.reason },
        )
    })
  }

  // (a) Is the change still a change to main, stated against the bytes it was verified on?
  async function check(session: DeliverySession): Promise<DeliveryRemote> {
    // Approval refused a protected path; the guard's list may have grown since. Asked again
    // here, before anything is read or written: the change itself may never touch one.
    const reached = protectedPathsIn(intent.paths.map((p) => p.path))
    if (reached.length > 0)
      throw new Stop(
        "delivery_base_conflict",
        `the change touches ${reached.join(", ")}, which a pull request from the factory may never change`,
        { paths: reached },
      )
    if (intent.issue.stateAtCreate === "open") {
      const state = await session.issueState(intent.issue.number)
      if (state === "closed")
        throw new Stop(
          "delivery_issue_closed",
          `issue #${intent.issue.number} was open when the work order was created and is closed now`,
        )
    }
    const baseTip = await session.branchHead(intent.baseBranch)
    if (baseTip === null)
      throw new Stop("delivery_base_conflict", `${intent.baseBranch} does not exist`)
    const comparison = await session.compare(intent.pin, baseTip)
    if (comparison.status !== "ahead" && comparison.status !== "identical")
      throw new Stop(
        "delivery_base_conflict",
        `the pin ${intent.pin} is not an ancestor of ${intent.baseBranch} at ${baseTip} (${comparison.status})`,
        { baseTip },
      )
    if (!comparison.complete)
      throw new Stop(
        "delivery_base_conflict",
        `${intent.baseBranch} changed ${comparison.files.length} or more files since the pin, more than one comparison can list; deliver from a fresh pin`,
        { baseTip, aheadBy: comparison.aheadBy },
      )
    const touched = new Set(intent.paths.map((p) => p.path))
    const overlap = [
      ...new Set(
        comparison.files.flatMap((file) =>
          [file.filename, file.previousFilename].filter(
            (name): name is string =>
              name !== undefined && (touched.has(name) || isRunFromBranchPath(name)),
          ),
        ),
      ),
    ].sort()
    if (overlap.length > 0)
      throw new Stop(
        "delivery_base_conflict",
        `${intent.baseBranch} changed ${overlap.join(", ")} since the pin; run the issue again at today's tip (--new)`,
        { baseTip, aheadBy: comparison.aheadBy, paths: overlap },
      )
    const pin = await session.commit(intent.pin)
    const paths = intent.paths.map((p) => p.path)
    const read = await readPinListings(pin.tree, paths, (sha) => session.tree(sha))
    if (!read.ok)
      throw new Stop("delivery_baseline_mismatch", read.problems.join("; "), {
        problems: read.problems,
      })
    const mismatched = intent.paths
      .map((p) => ({ path: p.path, baseline: p.baselineBlob, pin: read.entries.get(p.path)?.sha }))
      .filter((p) => p.pin !== p.baseline)
    if (mismatched.length > 0)
      throw new Stop(
        "delivery_baseline_mismatch",
        `the candidate was diffed against bytes that are not the pin's at ${mismatched.map((m) => m.path).join(", ")}`,
        { mismatched },
      )
    const modes = Object.fromEntries(
      intent.paths.map((p) => [p.path, read.entries.get(p.path)?.mode as "100644" | "100755"]),
    )
    const expectedTree = changedTreeId(
      read.listings,
      new Map(intent.paths.map((p) => [p.path, p.candidateBlob])),
    )
    return {
      check: { baseTip, aheadBy: comparison.aheadBy, pinTree: pin.tree, expectedTree, modes },
    }
  }

  // (b) The approved bytes as blobs, a tree on the pin's tree and one commit on the pin.
  async function commit(session: DeliverySession, row: OutboxRow): Promise<DeliveryRemote> {
    const checked = row.remote.check
    if (checked === undefined) throw new Stop("delivery_unconfirmed", "no check recorded")
    let changes: Record<string, unknown>
    try {
      changes = JSON.parse(await ctx.artifacts.read(intent.candidateArtifact)) as Record<
        string,
        unknown
      >
    } catch (error) {
      throw new Stop(
        "delivery_unconfirmed",
        `the approved bytes could not be read: ${String(error)}`,
      )
    }
    const texts = intent.paths.map((p) => {
      const text = changes[p.workspacePath]
      if (typeof text !== "string" || blobId(text) !== p.candidateBlob)
        throw new Stop(
          "delivery_unconfirmed",
          `the approved bytes of ${p.workspacePath} are not the ones the approval named`,
        )
      return text
    })
    ensureDelivering()
    for (const [index, p] of intent.paths.entries()) {
      const sha = await session.createBlob(texts[index] as string)
      if (sha !== p.candidateBlob)
        throw new Stop(
          "delivery_unconfirmed",
          `GitHub stored ${p.path} as blob ${sha}; the approved bytes hash to ${p.candidateBlob}`,
          { path: p.path, returned: sha, expected: p.candidateBlob },
        )
    }
    const tree = await session.createTree(
      checked.pinTree,
      intent.paths.map((p) => ({
        path: p.path,
        mode: checked.modes[p.path] ?? "100644",
        sha: p.candidateBlob,
      })),
    )
    if (tree !== checked.expectedTree)
      throw new Stop(
        "delivery_unconfirmed",
        `GitHub built tree ${tree}; the approved change makes ${checked.expectedTree}`,
        { returned: tree, expected: checked.expectedTree },
      )
    const identity = { ...session.identity, date: intent.approvedAt }
    const sha = await session.createCommit({
      message: commitMessage(intent),
      tree,
      parents: [intent.pin],
      author: identity,
      committer: identity,
    })
    const made = await session.commit(sha)
    if (made.tree !== checked.expectedTree || !sameParents(made.parents, intent.pin))
      throw new Stop("delivery_unconfirmed", `commit ${sha} is not the approved tree on the pin`)
    return { commit: { sha } }
  }

  /**
   * Is `sha` a commit of exactly this change: the approved tree, on the pin, alone? Judged by
   * tree and parent, not by author: a commit someone else made with the identical tree on the
   * pin is the approved bytes, and adopting it publishes exactly what was approved. Only the
   * app can create a `factory/*` branch (the rulesets), and confirm still requires the pull
   * request's author to be the app's bot.
   */
  async function isOurs(session: DeliverySession, sha: string, expectedTree: string) {
    const found = await session.commit(sha)
    return found.tree === expectedTree && sameParents(found.parents, intent.pin)
  }

  // (c) The branch at the commit, created once and never moved.
  async function branch(session: DeliverySession, row: OutboxRow): Promise<DeliveryRemote> {
    const want = row.remote.commit?.sha
    const expectedTree = row.remote.check?.expectedTree
    if (want === undefined || expectedTree === undefined)
      throw new Stop("delivery_unconfirmed", "no commit recorded")
    let head = await session.branchHead(intent.branch)
    if (head === null) {
      ensureDelivering()
      const created = await session.createBranch(intent.branch, want)
      head = created === "created" ? want : await session.branchHead(intent.branch)
      if (head === null)
        throw new Stop(
          "delivery_unconfirmed",
          `${intent.branch} was reported to exist and reads absent`,
        )
    }
    if (head !== want && !(await isOurs(session, head, expectedTree)))
      throw new Stop(
        "delivery_branch_conflict",
        `${intent.branch} exists at ${head}, which is not this change; the factory never moves a branch`,
        { head },
      )
    return { branch: { headSha: head } }
  }

  /** The pull request on our head, if there is exactly one we can call ours. */
  async function ourPull(session: DeliverySession, headSha: string) {
    const pulls = (await session.pullsByHead(intent.branch)).filter(
      (p) => p.headRef === intent.branch && p.headRepository === intent.repository,
    )
    const closed = pulls.find((p) => p.state === "closed")
    if (closed !== undefined)
      throw new Stop(
        "delivery_branch_conflict",
        `#${closed.number} on ${intent.branch} was ${closed.merged ? "merged" : "closed"}; the factory never reopens`,
        { number: closed.number },
      )
    const open = pulls.filter((p) => p.state === "open")
    if (open.length > 1)
      throw new Stop(
        "delivery_branch_conflict",
        `${open.length} open pull requests on ${intent.branch}`,
      )
    const [pull] = open
    if (pull === undefined) return undefined
    if (pull.baseRef !== intent.baseBranch || pull.headSha !== headSha)
      throw new Stop(
        "delivery_branch_conflict",
        `#${pull.number} on ${intent.branch} targets ${pull.baseRef} at head ${pull.headSha}, not ${intent.baseBranch} at ${headSha}`,
        { number: pull.number },
      )
    return pull
  }

  // (d) The draft pull request, found before it is created.
  async function open(session: DeliverySession, row: OutboxRow): Promise<DeliveryRemote> {
    const headSha = row.remote.branch?.headSha
    const checked = row.remote.check
    if (headSha === undefined || checked === undefined)
      throw new Stop("delivery_unconfirmed", "no branch recorded")
    let pull = await ourPull(session, headSha)
    if (pull === undefined) {
      ensureDelivering()
      const made = await session.createDraftPull({
        title: intent.title,
        body: pullBody(intent, checked),
        head: intent.branch,
        base: intent.baseBranch,
      })
      if (made === "exists") {
        pull = await ourPull(session, headSha)
        if (pull === undefined)
          throw new Stop(
            "delivery_unconfirmed",
            `GitHub says a pull request exists for ${intent.branch} and lists none`,
          )
      } else {
        pull = made
        if (!made.draft)
          throw new Stop(
            "delivery_unconfirmed",
            `#${made.number} was created as ready, not draft`,
            {
              number: made.number,
            },
          )
      }
    }
    return { pull: { number: pull.number, url: pull.url, nodeId: pull.nodeId } }
  }

  // Confirm: the receipt is what GitHub holds, read back, not what the writes answered.
  async function confirm(session: DeliverySession, row: OutboxRow): Promise<void> {
    const { pull: recorded, branch: branched, check: checked } = row.remote
    if (recorded === undefined || branched === undefined || checked === undefined)
      throw new Stop("delivery_unconfirmed", "no pull request recorded")
    const pull = await session.pull(recorded.number)
    if (pull.state !== "open")
      throw new Stop(
        "delivery_branch_conflict",
        `#${pull.number} was closed before it was confirmed`,
      )
    const problems = [
      pull.headRef === intent.branch ? null : `its head is ${pull.headRef}`,
      pull.headRepository === intent.repository ? null : `its head is in ${pull.headRepository}`,
      pull.baseRef === intent.baseBranch ? null : `its base is ${pull.baseRef}`,
      pull.author === session.botLogin ? null : `its author is ${pull.author}`,
      pull.headSha === branched.headSha ? null : `its head moved to ${pull.headSha}`,
    ].filter((p): p is string => p !== null)
    if (problems.length === 0 && !(await isOurs(session, pull.headSha, checked.expectedTree)))
      problems.push(`its head commit is not the approved tree on the pin`)
    if (problems.length > 0)
      throw new Stop("delivery_unconfirmed", `#${pull.number}: ${problems.join("; ")}`)
    const closing = await session.closingIssues(pull.number)
    if (closing.length > 0)
      throw new Stop(
        "delivery_unconfirmed",
        `#${pull.number} would close ${closing.map((n) => `#${n}`).join(", ")} on merge; edit its body`,
        { closing },
      )
    ctx.store.transaction(() => {
      ctx.outbox.advance(id, "opened", "confirmed", {}, ctx.iso())
      // The PR exists whatever happened to the row meanwhile: the receipt is the truth.
      ctx.store.recordDelivery({
        workOrderId: id,
        candidateDigest: intent.candidateDigest,
        receiptPath: pull.url,
        observedAt: ctx.iso(),
        pullRequest: {
          number: pull.number,
          url: pull.url,
          headSha: pull.headSha,
          treeSha: checked.expectedTree,
          baseTip: checked.baseTip,
          aheadBy: checked.aheadBy,
        },
      })
      if (ctx.mustGet(id).state === "delivering")
        ctx.transition(id, "delivery_confirmed", {}, { number: pull.number, url: pull.url })
      else ctx.recordEvent(id, "delivery_stopped", { state: ctx.mustGet(id).state, step: "opened" })
    })
  }

  try {
    const session = await attempt("session", () => deps.adapter.open(intent.repository, ctx.signal))
    for (;;) {
      // A closing controller stops between steps; the next boot's reconcile resumes here.
      if (ctx.signal.aborted) throw new Halted()
      const row = ctx.outbox.get(id) as OutboxRow
      if (row.step === "confirmed") return
      ensureDelivering()
      switch (row.step) {
        case "pending":
          if (
            !record(
              "pending",
              "checked",
              await attempt("check", () => check(session)),
              "delivery_checked",
            )
          )
            return
          break
        case "checked":
          if (
            !record(
              "checked",
              "committed",
              await attempt("commit", () => commit(session, row)),
              "delivery_committed",
            )
          )
            return
          break
        case "committed":
          if (
            !record(
              "committed",
              "branched",
              await attempt("branch", () => branch(session, row)),
              "delivery_branched",
            )
          )
            return
          break
        case "branched":
          if (
            !record(
              "branched",
              "opened",
              await attempt("pull", () => open(session, row)),
              "delivery_opened",
            )
          )
            return
          break
        case "opened":
          await attempt("confirm", () => confirm(session, row))
          return
      }
    }
  } catch (error) {
    // A cancel, or a controller closing (between steps or mid-request): journal what exists
    // remotely and leave the row as it is. Never a refusal: nothing went wrong with GitHub.
    if (error instanceof Halted || ctx.signal.aborted) {
      const row = ctx.outbox.get(id)
      ctx.recordEvent(id, "delivery_stopped", {
        state: ctx.mustGet(id).state,
        step: row?.step ?? null,
        observed: row?.remote ?? {},
        ...(ctx.signal.aborted ? { reason: "the controller is closing" } : {}),
      })
      return
    }
    refuse(
      error instanceof Stop
        ? error
        : new Stop("delivery_unconfirmed", `delivery failed: ${String(error)}`),
    )
  }
}
