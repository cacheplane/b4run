import type { GitTreeEntry } from "./git-objects.js"

/**
 * What the delivery worker asks of GitHub, and nothing more (rung 4 spec §5.2, §6.2). The
 * worker owns the sequence and every judgement (what is ours, what conflicts, what proves
 * delivery); an adapter only carries one request and classifies its failure. Rung 4's real
 * adapter is GitHub's REST and GraphQL APIs under an installation token (`github/adapter.ts`);
 * the tests use an in-memory repository (`test/fake-delivery-adapter.ts`).
 *
 * There is deliberately no update, force, delete, merge, ready, comment or close here: the
 * worker cannot ask for what the interface cannot say.
 */

/** Why a request failed, as the worker needs to know it (spec §6.5). */
export type DeliveryErrorKind =
  /** A 401, a non-rate-limit 403, a mint refusal, a missing installation: never heals by waiting. */
  | "unauthorized"
  /** A 429, or a 403 carrying `retry-after` or `x-ratelimit-remaining: 0`. */
  | "rate_limited"
  /** A 5xx or a network failure: retried with backoff. */
  | "transient"
  /** A 404 where the worker asked for something specific. */
  | "not_found"
  /** A 409 or 422 the request itself could not explain: answered by the step's own read. */
  | "conflict"
  /**
   * GitHub answered a listing cut short (a tree `truncated: true`): the pin's listing is as
   * long tomorrow, so it never heals by waiting.
   */
  | "incomplete"
  /** Anything else: a response that does not parse, a status nothing expects. */
  | "unexpected"

export class DeliveryError extends Error {
  constructor(
    readonly kind: DeliveryErrorKind,
    message: string,
    /** How long the server asked the caller to wait, when it said. */
    readonly retryAfterMs?: number,
    readonly status?: number,
  ) {
    super(message)
    this.name = "DeliveryError"
  }
}

export interface RemoteCommit {
  readonly sha: string
  readonly tree: string
  readonly parents: readonly string[]
}

export interface Comparison {
  /** `ahead` or `identical` when the base is an ancestor of the head. */
  readonly status: "ahead" | "behind" | "diverged" | "identical"
  readonly aheadBy: number
  readonly files: readonly { readonly filename: string; readonly previousFilename?: string }[]
  /** False when the comparison could not list every changed file (GitHub caps it at 300). */
  readonly complete: boolean
}

export interface RemotePull {
  readonly number: number
  readonly url: string
  readonly nodeId: string
  readonly state: "open" | "closed"
  readonly draft: boolean
  readonly merged: boolean
  readonly author: string
  readonly headRef: string
  /** `owner/name` of the head's repository; null when it was deleted. */
  readonly headRepository: string | null
  readonly headSha: string
  readonly baseRef: string
}

export interface CommitIdentity {
  readonly name: string
  readonly email: string
  /** ISO-8601; the approval's time, so a repeated create usually yields the same commit. */
  readonly date: string
}

/** One worker run's authenticated view of one repository. */
export interface DeliverySession {
  /** The app's bot login (`<slug>[bot]`), as GitHub reports the app. */
  readonly botLogin: string
  /** The commit identity the worker writes as: the app's bot. */
  readonly identity: Omit<CommitIdentity, "date">
  /**
   * What GitHub writes as the message of a squash merge and of a merge commit on this
   * repository (`squash_merge_commit_message`: `COMMIT_MESSAGES`, `PR_BODY` or `BLANK`;
   * `merge_commit_message`: `PR_TITLE`, `PR_BODY` or `BLANK`), as the repository read at open
   * answered them; null when it did not say.
   */
  readonly mergeMessages: { readonly squash: string | null; readonly merge: string | null }
  /** Rule types (`update`, `non_fast_forward`, ...) the repository's rulesets apply to `branch`. */
  branchRules(branch: string): Promise<readonly string[]>
  /**
   * `gone` when the issue is no longer this repository's: transferred (GitHub answers 301; the
   * move is never followed) or deleted (410).
   */
  issueState(number: number): Promise<"open" | "closed" | "gone">
  /** The commit `refs/heads/<branch>` points at, or null when it does not exist. */
  branchHead(branch: string): Promise<string | null>
  compare(base: string, head: string): Promise<Comparison>
  commit(sha: string): Promise<RemoteCommit>
  /** One tree's own entries, non-recursive; `incomplete` when GitHub cut the listing short. */
  tree(sha: string): Promise<readonly GitTreeEntry[]>
  createBlob(text: string): Promise<string>
  createTree(
    baseTree: string,
    entries: readonly { readonly path: string; readonly mode: string; readonly sha: string }[],
  ): Promise<string>
  createCommit(input: {
    readonly message: string
    readonly tree: string
    readonly parents: readonly string[]
    readonly author: CommitIdentity
    readonly committer: CommitIdentity
  }): Promise<string>
  /** Create `refs/heads/<branch>` at `sha`; `exists` when the ref is already there (a 422). */
  createBranch(branch: string, sha: string): Promise<"created" | "exists">
  /** Open and closed pull requests whose head is `<owner>:<branch>`. */
  pullsByHead(branch: string): Promise<readonly RemotePull[]>
  /** A draft pull request; `exists` when GitHub says one already exists for the head (a 422). */
  createDraftPull(input: {
    readonly title: string
    readonly body: string
    readonly head: string
    readonly base: string
  }): Promise<RemotePull | "exists">
  pull(number: number): Promise<RemotePull>
  /** The issue numbers merging the pull request would close. */
  closingIssues(number: number): Promise<readonly number[]>
}

export interface DeliveryAdapter {
  /**
   * Authenticate for `repository` (a token minted for this run, downscoped to it) and check
   * the installation grants what delivery needs; `unauthorized` otherwise.
   */
  open(repository: string, signal: AbortSignal): Promise<DeliverySession>
  /** Secrets the adapter holds now, for the scrubber: never journalled. */
  secrets(): readonly string[]
}
