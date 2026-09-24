import { join } from "node:path"
import { createTwoFilesPatch } from "diff"
import { bundleDigest } from "../domain/digest.js"
import type { Bundle, Candidate, Receipt, WorkOrderRow } from "../domain/work-order.js"
import { readGeneratedTask } from "../intake/generated-task.js"
import type { ArtifactStore } from "../storage/artifacts.js"
import { BundlePayloadSchema } from "./bundle.js"

/**
 * What `factory review` shows a person and what it may then approve. `digest` is computed
 * from the very values `text` was rendered from, each read once: the task files' buffers for
 * an intake, the bundle payload for an export. Nothing is read a second time between the
 * display and the digest, so what the person read is what the approval names.
 */
export interface OperatorReview {
  readonly kind: "intake" | "export"
  /** The row the review was built from, once. */
  readonly row: WorkOrderRow
  /** The row's revision when it was read: the approval is sent at this revision. */
  readonly revision: number
  /** The task digest (intake) or the bundle digest (export) of what `text` shows. */
  readonly digest: string
  /** `task digest` or `bundle digest`, for messages. */
  readonly label: string
  readonly text: string
  /**
   * Why what was displayed may not be approved: the bytes digest to something other than the
   * row's, a piece of evidence is missing or does not hash to its name, a record contradicts
   * another. Non-empty means the review refuses after displaying.
   */
  readonly problems: readonly string[]
  /**
   * What the person is approving without having seen, allowed only by an explicit flag
   * (`--allow-missing-evidence`): said loudly beside the prompt, never silently.
   */
  readonly warnings: readonly string[]
}

/**
 * The bytes a changed path had at the commit the candidate is diffed against, read once:
 * `absent` when the commit has no such file (a file the candidate adds), `unavailable` when
 * the commit itself cannot be read (not in the object store, no repository), with the reason.
 */
export type PinnedFile =
  | { readonly kind: "bytes"; readonly bytes: Buffer }
  | { readonly kind: "absent" }
  | { readonly kind: "unavailable"; readonly reason: string }

/** Where the export review's diff comes from: a label for the old side, and each path's bytes. */
export interface DiffBase {
  /** e.g. `pin 6a59e00aed46`; the old side's header in every hunk. */
  readonly label: string
  /** A line said once above the diffs, when the base is not exactly the builder's baseline. */
  readonly note?: string
  read(path: string): PinnedFile
}

/**
 * Characters a terminal would act on, or that show as nothing, rather than showing what they
 * are: C0 and C1 controls (an ANSI escape can erase or recolour the lines around it), the
 * bidirectional marks, overrides and isolates (which reorder what is shown), the zero-width
 * characters and the byte order mark (invisible), the line and paragraph separators (a line
 * break some terminals honour), and the tag characters (invisible text). Drafted files are
 * model output and the issue is anyone's: the person must see every character, so these are
 * shown as `\u{…}` escapes. Newline and tab are left as they are in a body; a title or any
 * other one-line value escapes them too ({@link displayableLine}).
 */
const HIDDEN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the controls is the point
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu

const escapeChar = (c: string) => `\\u{${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}}`

/** Text for a body: every hidden character escaped; newline and tab kept. */
export function displayable(text: string): string {
  return text.replace(HIDDEN, escapeChar)
}

/** A value shown inside one line (a title, a path, an id, a reason): newline and tab escaped too. */
export function displayableLine(text: string): string {
  return displayable(text).replace(/[\t\n]/g, escapeChar)
}

/**
 * Fatal, so bytes that are not UTF-8 are said rather than replaced; `ignoreBOM`, so a byte
 * order mark is kept and shown escaped rather than silently dropped from what is displayed.
 */
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/** The gutter every body line is shown behind: no content can start a line of the review. */
const GUTTER = "│ "
/** A run of blank lines longer than this is shown as one line saying how many. */
const MAX_BLANK_RUN = 3

/**
 * A body behind the gutter. Every line of content, the empty ones included, starts with
 * {@link GUTTER}, so a file cannot produce a `==>` title, a `Task digest` line or anything
 * else the review itself writes; a long run of blank lines (which could push the rest of a
 * file out of sight) is collapsed into one line that says how many there were.
 */
function guttered(body: string): string {
  const lines = displayable(body).split("\n")
  const missingNewline = lines.at(-1) !== ""
  if (!missingNewline) lines.pop()
  let out = ""
  let blanks = 0
  const flush = () => {
    if (blanks > MAX_BLANK_RUN) out += `${GUTTER}… ${blanks} blank lines …\n`
    else out += `${GUTTER}\n`.repeat(blanks)
    blanks = 0
  }
  for (const line of lines) {
    if (line.trim() === "") {
      blanks++
      continue
    }
    flush()
    out += `${GUTTER}${line}\n`
  }
  flush()
  return missingNewline ? `${out}(no newline at end of file)\n` : out
}

/** A titled block: the title escaped to one line, the body behind the gutter. */
function block(title: string, body: string): string {
  return `==> ${displayableLine(title)}\n${guttered(body)}\n`
}

/** The generated task's files in reading order: the issue, the spec, the task, the checks. */
const FIRST = ["issue.md", "spec.md", "task.json", "checks.json"]
function readingOrder(paths: Iterable<string>): string[] {
  const all = [...paths]
  const rest = all.filter((p) => !FIRST.includes(p)).sort()
  return [...FIRST.filter((p) => all.includes(p)), ...rest]
}

/**
 * A receipt, and the output each of its checks recorded, read from the artifact store. The
 * store re-hashes every artifact against its name, so an output that was edited is reported
 * as a problem rather than shown as evidence. An output the store does not hold is shown as
 * missing and collected in `missing`: the caller decides whether that may be approved.
 */
async function receiptBlock(
  title: string,
  receipt: Receipt,
  artifacts: ArtifactStore,
  problems: string[],
  /** Collects the id of each evidence item the store does not hold. */
  missing: string[],
): Promise<string> {
  const line = displayableLine
  let out = `--- ${title}: receipt ${line(receipt.id)}, verdict ${receipt.verdict}\n`
  out += `    verifier ${line(receipt.verifierIdentity)}, environment ${line(receipt.environmentIdentity)}, issued ${line(receipt.issuedAt)}\n\n`
  for (const check of receipt.checks) {
    const ids = check.acceptanceIds.length > 0 ? ` (${check.acceptanceIds.join(", ")})` : ""
    out += `  check ${line(check.id)}${line(ids)}: ${check.verdict}\n`
    for (const item of check.evidence) {
      let content: string
      try {
        content = await artifacts.read(item.digest)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.startsWith("Artifact not found")) {
          missing.push(item.id)
          out += `  ${line(item.id)}: NOT IN THE ARTIFACT STORE (${item.digest})\n`
          continue
        }
        problems.push(`Evidence ${item.id} of receipt ${receipt.id} is unreadable: ${message}`)
        out += `  ${line(item.id)}: unreadable (${line(message)})\n`
        continue
      }
      out += block(`${item.id} (artifact ${item.digest})`, content)
    }
  }
  return `${out}\n`
}

/**
 * Evidence the store does not hold was not shown, so it cannot have been read: a problem,
 * unless the person passed `--allow-missing-evidence`, and then a warning said beside the
 * prompt. Nothing in a receipt reliably marks a verifier that never writes its output (the
 * identity is a free-form string), so this is the person's explicit choice, never inferred.
 */
function missingEvidence(
  what: string,
  missing: readonly string[],
  allow: boolean | undefined,
  into: { problems: string[]; warnings: string[] },
): void {
  if (missing.length === 0) return
  const said = `${what} (${missing.join(", ")}) is not in the artifact store, so it was not shown`
  if (allow === true) into.warnings.push(`${said}; approving without it (--allow-missing-evidence)`)
  else
    into.problems.push(
      `${said}; restore it, or pass --allow-missing-evidence to approve without seeing it`,
    )
}

/**
 * The review of a draft parked in `awaiting_intake_approval`: every file of the generated task
 * (the issue, `spec.md`, `task.json`, `checks.json`, the check file) and the oracle proof's
 * output, with the task digest computed over exactly the buffers shown.
 */
export async function intakeReview(input: {
  readonly row: WorkOrderRow
  readonly generatedTasksDir: string
  readonly oracleReceipt: Receipt | null
  readonly artifacts: ArtifactStore
  /**
   * Approve even when the oracle proof's output is not in the artifact store. Nothing in a
   * receipt reliably marks a verifier that never writes its output (the identity is a
   * free-form string), so a missing output refuses unless the person says so explicitly.
   */
  readonly allowMissingEvidence?: boolean
}): Promise<OperatorReview> {
  const { row } = input
  const problems: string[] = []
  const warnings: string[] = []
  const directory = join(input.generatedTasksDir, row.id)
  let text = `Intake review of ${row.id} (${row.state}, revision ${row.revision})\n`
  text += `Generated task: ${displayableLine(directory)}\n\n`
  let read: ReturnType<typeof readGeneratedTask>
  try {
    read = readGeneratedTask(directory)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      kind: "intake",
      row,
      revision: row.revision,
      digest: "",
      label: "task digest",
      text,
      problems: [`Generated task unreadable: ${message}`],
      warnings,
    }
  }
  for (const path of readingOrder(read.files.keys())) {
    // biome-ignore lint/style/noNonNullAssertion: the path came from this map's own keys
    const bytes = read.files.get(path)!
    let content: string
    try {
      content = utf8.decode(bytes)
    } catch {
      problems.push(`${path} is not valid UTF-8, so it cannot be shown as it is`)
      text += `==> ${displayableLine(path)}\n(${bytes.length} bytes, not valid UTF-8)\n\n`
      continue
    }
    text += block(`${path} (${bytes.length} bytes)`, content)
  }
  if (input.oracleReceipt === null) {
    problems.push("No oracle proof is recorded for this task digest")
    text += "--- Oracle proof: none recorded for this task digest\n\n"
  } else {
    const missing: string[] = []
    text += await receiptBlock(
      "Oracle proof (the check run on the unpatched baseline)",
      input.oracleReceipt,
      input.artifacts,
      problems,
      missing,
    )
    missingEvidence("The oracle proof's output", missing, input.allowMissingEvidence, {
      problems,
      warnings,
    })
  }
  text += `Task digest of the ${read.files.size} files above: ${read.digest}\n`
  if (row.taskDigest === null) problems.push("The work order has no task digest to approve")
  else if (read.digest !== row.taskDigest)
    problems.push(
      `The task files digest to ${read.digest}, but the work order parked ${row.taskDigest}: they changed after the draft was proved`,
    )
  return {
    kind: "intake",
    row,
    revision: row.revision,
    digest: read.digest,
    label: "task digest",
    text,
    problems,
    warnings,
  }
}

/**
 * One changed file as the reviewer reads it: a unified diff of the candidate's bytes (the ones
 * the bundle digest covers, exactly as the export writes them) against the base's bytes for
 * that path, read once. A file the base does not have is shown all-added. When the base cannot
 * be read the whole file is shown, with a line saying why: a reviewer is never shown less than
 * the change.
 */
function changedFile(path: string, content: string, base: DiffBase | undefined): string {
  if (base === undefined) return block(`${path} (the whole file as the export writes it)`, content)
  const old = base.read(path)
  if (old.kind === "unavailable")
    return block(
      `${path} (the whole file as the export writes it: no diff, because ${old.reason})`,
      content,
    )
  let before = ""
  if (old.kind === "bytes") {
    try {
      before = utf8.decode(old.bytes)
    } catch {
      return block(
        `${path} (the whole file as the export writes it: no diff, because the ${base.label} copy is not valid UTF-8)`,
        content,
      )
    }
  }
  if (before === content)
    return `==> ${displayableLine(path)}\n(identical to ${displayableLine(base.label)})\n\n`
  const patch = createTwoFilesPatch(
    old.kind === "absent" ? "/dev/null" : `a/${path}`,
    `b/${path}`,
    before,
    content,
    base.label,
    "candidate",
    { context: 3 },
  )
  // The patch's own `Index`/`=====` preamble is dropped: the `==>` title names the file.
  const body = patch.slice(patch.indexOf("--- "))
  const kind =
    old.kind === "absent" ? `new file, not in ${base.label}` : `diff against ${base.label}`
  return block(`${path} (${kind})`, body)
}

/**
 * The review of a bundle parked in `awaiting_approval`: the candidate's changed files (the
 * bytes the export writes, read from the artifact store, which re-hashes them against the
 * candidate's record), each as a diff against `base` when one is given, the receipt with its
 * check output, and the frozen bundle, whose digest is recomputed from the payload shown. The
 * diff is only the display: what is digested and approved is the bundle, as before.
 */
export async function exportReview(input: {
  readonly row: WorkOrderRow
  readonly candidate: Candidate | null
  readonly receipt: Receipt | null
  readonly bundle: Bundle | null
  readonly artifacts: ArtifactStore
  /** What the candidate's files are diffed against; absent, each file is shown whole. */
  readonly base?: DiffBase
  /** Approve even when the receipt's check output is not in the artifact store. */
  readonly allowMissingEvidence?: boolean
}): Promise<OperatorReview> {
  const { row, candidate, receipt, bundle } = input
  const problems: string[] = []
  const warnings: string[] = []
  let text = `Export review of ${row.id} (${row.state}, revision ${row.revision})\n\n`
  if (candidate === null) {
    problems.push("The work order has no assembled candidate")
    text += "--- Candidate: none recorded\n\n"
  } else {
    text += `--- Candidate ${candidate.digest}: ${candidate.changedPaths.length} changed path(s), ${candidate.bytes} bytes\n`
    text += `    baseline ${candidate.baselineDigest}, artifact ${candidate.artifactDigest}\n\n`
    try {
      const changes = JSON.parse(await input.artifacts.read(candidate.artifactDigest)) as Record<
        string,
        unknown
      >
      if (input.base?.note) text += `${displayableLine(input.base.note)}\n\n`
      for (const path of Object.keys(changes).sort()) {
        const content = changes[path]
        if (typeof content === "string") text += changedFile(path, content, input.base)
        else {
          problems.push(`The candidate's entry for ${path} is not file content`)
          text += `==> ${displayableLine(path)}\n(not file content)\n\n`
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      problems.push(`The candidate's bytes are unreadable: ${message}`)
      text += `(candidate bytes unreadable: ${displayableLine(message)})\n\n`
    }
  }
  if (receipt === null) {
    problems.push("The work order has no receipt")
    text += "--- Receipt: none recorded\n\n"
  } else {
    const missing: string[] = []
    text += await receiptBlock("Verification", receipt, input.artifacts, problems, missing)
    missingEvidence("The receipt's check output", missing, input.allowMissingEvidence, {
      problems,
      warnings,
    })
    if (candidate !== null && receipt.candidateDigest !== candidate.digest)
      problems.push(
        `Receipt ${receipt.id} is for candidate ${receipt.candidateDigest}, not this one`,
      )
  }
  if (bundle === null) {
    problems.push("The work order has no frozen bundle")
    text += "--- Bundle: none frozen\n"
    return {
      kind: "export",
      row,
      revision: row.revision,
      digest: "",
      label: "bundle digest",
      text,
      problems,
      warnings,
    }
  }
  const parsed = BundlePayloadSchema.safeParse(bundle.payload)
  text += block(
    `Bundle ${bundle.digest} (frozen ${bundle.frozenAt})`,
    `${JSON.stringify(bundle.payload, null, 2)}\n`,
  )
  if (!parsed.success) {
    problems.push("The frozen bundle's payload does not parse; deny it and create a new work order")
    return {
      kind: "export",
      row,
      revision: row.revision,
      digest: "",
      label: "bundle digest",
      text,
      problems,
      warnings,
    }
  }
  const payload = parsed.data
  const digest = bundleDigest(payload)
  text += `Bundle digest of the payload above: ${digest}\n`
  if (digest !== row.bundleDigest)
    problems.push(
      `The payload digests to ${digest}, but the work order froze ${String(row.bundleDigest)}`,
    )
  if (candidate !== null && payload.candidateDigest !== candidate.digest)
    problems.push(`The bundle names candidate ${payload.candidateDigest}, not the one shown`)
  if (receipt !== null && payload.receiptId !== receipt.id)
    problems.push(`The bundle names receipt ${payload.receiptId}, not the one shown`)
  return {
    kind: "export",
    row,
    revision: row.revision,
    digest,
    label: "bundle digest",
    text,
    problems,
    warnings,
  }
}
