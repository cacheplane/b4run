import type { DeliveryIntent } from "./outbox.js"
import { scrub } from "./scrub.js"

/** GitHub's limit on a pull request body, in characters. */
export const BODY_LIMIT = 65_536
const TITLE_LIMIT = 200

/**
 * Model-influenced text made safe to show in one line: control characters and line and
 * paragraph separators removed, whitespace collapsed.
 */
function oneLine(text: string): string {
  return text
    .replace(/[\p{Cc}\u2028\u2029]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Model-written text made unable to reference an issue (D29): a squash merge takes the PR's
 * title as its commit subject, and GitHub closes `#77` (or `owner/repo#77`, `GH-77`, or an
 * issue or pull request URL) after a closing keyword (`close[sd]?`, `fix(e[sd])?`,
 * `resolve[sd]?`) in a commit landing on the default branch. Every reference is broken, so
 * no keyword before it can close anything; the words themselves ("Fix the timer") stay.
 */
export function neutraliseReferences(text: string): string {
  return text
    .replace(/(?:https?:\/\/)?github\.com\/[^\s/]+\/[^\s/]+\/(issues|pull)\/(\d+)/gi, "$1 $2")
    .replace(/\bGH-(\d)/gi, "GH $1")
    .replace(/#(?=\d)/g, "# ")
}

/**
 * The pull request's title (spec §7.1): the approved spec's first `# ` heading, else the
 * issue's title from `issue.md` (`# <title> (<repo>#<n>)`), cleaned, cut to 200 characters,
 * prefixed `factory: `, with any credential shape scrubbed and every issue reference broken
 * (a squash merge can take the title as its commit subject).
 */
export function pullTitle(specText: string, issueText: string): string {
  // Split on \n only: a regex `$` (and `.`) also stops at U+2028, which would cut a heading short.
  const heading = (text: string) =>
    text
      .split("\n")
      .find((line) => /^# +\S/.test(line))
      ?.replace(/^# +/, "")
  const fromIssue = heading(issueText)?.replace(/ \([^()]*#\d+\)$/, "")
  const title = oneLine(heading(specText) ?? fromIssue ?? "")
  const safe = neutraliseReferences(scrub(title))
  return `factory: ${(safe === "" ? "an approved change" : safe).slice(0, TITLE_LIMIT)}`
}

/** A fence `text` cannot close: one more backtick than its longest run, and at least three. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  return "`".repeat(Math.max(3, longest + 1))
}

/**
 * `text` inside a fence it cannot close. The changed paths are fenced as well as the spec: the
 * candidate names them, a path may be `a/fixes #1.ts`, and GitHub closes an issue from a
 * closing keyword in a pull request's description, but not from inside a code block.
 */
function fenced(text: string, info = ""): string {
  const fence = fenceFor(text)
  return `${fence}${info}\n${text.endsWith("\n") ? text : `${text}\n`}${fence}`
}

export interface BodyFacts {
  readonly baseTip: string
  readonly aheadBy: number
}

/**
 * The pull request's body (spec §7.2), rendered only from frozen data: the intent the
 * approval committed and what step (a) read. `Refs #N`, never a closing keyword, so merging
 * never closes the issue on the factory's say-so. The approved spec is model-written and
 * sits inside a fence it cannot close, as do the changed paths, which the candidate names; when the body would pass GitHub's limit the quoted
 * spec is cut, never the digests, which are the authority.
 */
export function pullBody(intent: DeliveryIntent, facts: BodyFacts): string {
  const head = [
    `Refs #${intent.issue.number}`,
    "",
    `Produced by the B4.run software factory from issue #${intent.issue.number} and approved by a person`,
    `(recorded actor: ${oneLine(intent.decidedBy)}) on ${intent.approvedAt}. This is a draft. The factory never merges.`,
    ...(intent.issue.stateAtCreate === "closed"
      ? ["", `Issue #${intent.issue.number} was already closed when this work order was created.`]
      : []),
    "",
    "## Pin and drift",
    `Branched at ${intent.pin}. main was at ${facts.baseTip} when delivered, ${facts.aheadBy} commits ahead of the pin.`,
    "No file this change touches changed on main in between.",
    "",
    "## Approved task",
  ].join("\n")
  const d = intent.digests
  const tail = [
    "",
    "## Digests and receipts",
    `task ${d.task} · bundle ${intent.bundleDigest} · candidate ${intent.candidateDigest}`,
    `oracle receipt ${d.oracleReceiptId ?? "none"} · verification receipt ${d.receiptId} · re-verification at approval ${d.reverificationReceiptId}`,
    `policy ${d.policy} · environment ${oneLine(d.environment)}`,
    "",
    fenced(
      intent.paths
        .map(
          // Step (a) proved the pin's blob at each path is the baseline's, so "before" is it.
          (p) => `${p.path}: ${p.baselineBlob} → ${p.candidateBlob}`,
        )
        .join("\n"),
    ),
    "",
  ].join("\n")
  const quote = (spec: string) => fenced(spec, "markdown")
  // The spec is model-written: no credential shape reaches GitHub, even quoted.
  const specText = scrub(intent.specText)
  const whole = `${head}\n${quote(specText)}\n${tail}`
  if (whole.length <= BODY_LIMIT) return whole
  const note =
    "\n(The approved spec is cut here to fit GitHub's body limit; its digest above is the authority.)"
  const room = BODY_LIMIT - head.length - tail.length - note.length - 64
  const cut = specText.slice(0, Math.max(0, room))
  return `${head}\n${quote(cut)}${note}\n${tail}`
}

/** The commit message: from the intent alone, so a repeated create writes the same commit. */
export function commitMessage(intent: DeliveryIntent): string {
  return `${neutraliseReferences(scrub(intent.title))}\n\nRefs #${intent.issue.number}\n\nWork order ${intent.workOrderId}, bundle ${intent.bundleDigest}.\n`
}
