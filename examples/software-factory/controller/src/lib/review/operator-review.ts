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
 * Characters a terminal would act on rather than show: C0 and C1 controls (an ANSI escape can
 * erase or recolour the lines around it) and the bidirectional overrides and isolates (which
 * reorder what is shown). A drafted `spec.md` is model output; the person must see every byte
 * of it, so these are shown as escapes. Newline and tab are left as they are.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the controls is the point
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu

export function displayable(text: string): string {
  return text.replace(
    HIDDEN,
    (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}}`,
  )
}

const utf8 = new TextDecoder("utf-8", { fatal: true })

/** A titled block of text, ending in exactly one newline, with a missing final newline said. */
function block(title: string, body: string): string {
  const shown = displayable(body)
  return `==> ${title}\n${shown.endsWith("\n") ? shown : `${shown}\n(no newline at end of file)\n`}\n`
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
 * missing (a fake verifier records digests it never wrote), not refused.
 */
async function receiptBlock(
  title: string,
  receipt: Receipt,
  artifacts: ArtifactStore,
  problems: string[],
): Promise<string> {
  let out = `--- ${title}: receipt ${receipt.id}, verdict ${receipt.verdict}\n`
  out += `    verifier ${receipt.verifierIdentity}, environment ${receipt.environmentIdentity}, issued ${receipt.issuedAt}\n\n`
  for (const check of receipt.checks) {
    const ids = check.acceptanceIds.length > 0 ? ` (${check.acceptanceIds.join(", ")})` : ""
    out += `  check ${check.id}${ids}: ${check.verdict}\n`
    for (const item of check.evidence) {
      let content: string
      try {
        content = await artifacts.read(item.digest)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.startsWith("Artifact not found")) {
          out += `  ${item.id}: not in the artifact store (${item.digest})\n`
          continue
        }
        problems.push(`Evidence ${item.id} of receipt ${receipt.id} is unreadable: ${message}`)
        out += `  ${item.id}: unreadable (${message})\n`
        continue
      }
      out += block(`${item.id} (artifact ${item.digest})`, content)
    }
  }
  return `${out}\n`
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
}): Promise<OperatorReview> {
  const { row } = input
  const problems: string[] = []
  const directory = join(input.generatedTasksDir, row.id)
  let text = `Intake review of ${row.id} (${row.state}, revision ${row.revision})\n`
  text += `Generated task: ${directory}\n\n`
  let read: ReturnType<typeof readGeneratedTask>
  try {
    read = readGeneratedTask(directory)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      kind: "intake",
      revision: row.revision,
      digest: "",
      label: "task digest",
      text,
      problems: [`Generated task unreadable: ${message}`],
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
      text += `==> ${path}\n(${bytes.length} bytes, not valid UTF-8)\n\n`
      continue
    }
    text += block(`${path} (${bytes.length} bytes)`, content)
  }
  if (input.oracleReceipt === null) {
    problems.push("No oracle proof is recorded for this task digest")
    text += "--- Oracle proof: none recorded for this task digest\n\n"
  } else {
    text += await receiptBlock(
      "Oracle proof (the check run on the unpatched baseline)",
      input.oracleReceipt,
      input.artifacts,
      problems,
    )
  }
  text += `Task digest of the ${read.files.size} files above: ${read.digest}\n`
  if (row.taskDigest === null) problems.push("The work order has no task digest to approve")
  else if (read.digest !== row.taskDigest)
    problems.push(
      `The task files digest to ${read.digest}, but the work order parked ${row.taskDigest}: they changed after the draft was proved`,
    )
  return {
    kind: "intake",
    revision: row.revision,
    digest: read.digest,
    label: "task digest",
    text,
    problems,
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
  if (before === content) return `==> ${path}\n(identical to ${base.label})\n\n`
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
}): Promise<OperatorReview> {
  const { row, candidate, receipt, bundle } = input
  const problems: string[] = []
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
      if (input.base?.note) text += `${input.base.note}\n\n`
      for (const path of Object.keys(changes).sort()) {
        const content = changes[path]
        if (typeof content === "string") text += changedFile(path, content, input.base)
        else {
          problems.push(`The candidate's entry for ${path} is not file content`)
          text += `==> ${path}\n(not file content)\n\n`
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      problems.push(`The candidate's bytes are unreadable: ${message}`)
      text += `(candidate bytes unreadable: ${message})\n\n`
    }
  }
  if (receipt === null) {
    problems.push("The work order has no receipt")
    text += "--- Receipt: none recorded\n\n"
  } else {
    text += await receiptBlock("Verification", receipt, input.artifacts, problems)
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
      revision: row.revision,
      digest: "",
      label: "bundle digest",
      text,
      problems,
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
      revision: row.revision,
      digest: "",
      label: "bundle digest",
      text,
      problems,
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
  return { kind: "export", revision: row.revision, digest, label: "bundle digest", text, problems }
}
