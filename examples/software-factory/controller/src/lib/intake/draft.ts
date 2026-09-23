import { z } from "zod"
import {
  assertTaskFitsTarget,
  type Checks,
  ChecksSchema,
  isCatalogId,
  loadTarget,
  relativePath,
  TaskFieldsSchema,
  type TaskManifest,
  TaskSchema,
} from "../targets/catalog.js"

/** Where the drafter writes, relative to its workspace. Keys outside it are not the draft. */
export const DRAFT_ROOT = "draft/"

/** The draft's own checks manifest: the independent suite only. The visible suite is the controller's. */
const DraftChecksSchema = z.object({ independent: ChecksSchema.shape.independent }).strict()
/** The draft's task manifest: everything but the id, which is the work order's. */
const DraftTaskSchema = TaskFieldsSchema.omit({ id: true }).strict()

/**
 * The visible suite every generated task carries: the target's whole vitest suite with no
 * named assertions, meaning "all of it must still pass". The draft cannot supply one because
 * a drafter naming a subset would narrow the regression guard to what it chose to look at.
 */
const REGRESSION_GUARD: Checks["visible"] = { runner: "vitest", assertions: [] }

const ACCEPTANCE_ID = /^(A\d+):/

export interface ParsedDraft {
  readonly manifest: TaskManifest
  readonly checks: Checks
  readonly specText: string
  readonly acceptanceIds: readonly string[]
  /** Every `draft/`-relative file, for materialisation: the three manifests and the one check. */
  readonly files: ReadonlyMap<string, string>
}
export type DraftRefusal = {
  readonly ok: false
  readonly reason: string
  readonly blockedReason: "intake_invalid" | "no_target_for_package"
}
export type ParseResult = ({ readonly ok: true } & ParsedDraft) | DraftRefusal

/** `A<n>:` at the start of a line in spec.md, in order of first appearance, once each. */
export function acceptanceIdsOf(specText: string): string[] {
  const ids: string[] = []
  for (const line of specText.split(/\r?\n/)) {
    const id = line.match(ACCEPTANCE_ID)?.[1]
    if (id !== undefined && !ids.includes(id)) ids.push(id)
  }
  return ids
}

const invalid = (reason: string): DraftRefusal => ({
  ok: false,
  reason,
  blockedReason: "intake_invalid",
})

/**
 * `draft/<file>` as JSON, or the refusal that names it. The two arms are told apart by a
 * wrapper the drafter cannot write: the parsed value is drafter-controlled JSON, so its
 * shape must never decide whether it is a refusal.
 */
type ReadJson =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "refusal"; readonly refusal: DraftRefusal }
function readJson(files: ReadonlyMap<string, string>, file: string): ReadJson {
  const text = files.get(file)
  if (text === undefined)
    return { kind: "refusal", refusal: invalid(`${DRAFT_ROOT}${file} is missing`) }
  try {
    return { kind: "value", value: JSON.parse(text) }
  } catch (error) {
    return {
      kind: "refusal",
      refusal: invalid(`${DRAFT_ROOT}${file} is not valid JSON: ${String(error)}`),
    }
  }
}

/**
 * A draft key, once `draft/` is stripped, is joined under the task directory when the task
 * is materialised. It must be canonical (`relativePath`: no `.`/`..`/empty segment, no
 * leading or trailing slash, no backslash) and carry no NUL, or a `checks/../..` key could
 * write outside that directory.
 */
function nonCanonicalKey(draft: ReadonlyMap<string, string>): DraftRefusal | undefined {
  for (const path of draft.keys())
    if (path.includes("\0") || !relativePath.safeParse(path).success)
      return invalid(
        `draft file ${JSON.stringify(`${DRAFT_ROOT}${path}`)} is not a canonical relative path`,
      )
  return undefined
}

/** One line per issue: what failed and where, without zod's multi-line rendering. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ")
}

/** Sorted, de-duplicated. */
const sortedSet = (values: readonly string[]): string[] => [...new Set(values)].sort()
const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index])

/**
 * A draft carries exactly four files: the three manifests and the one check `checks.json`
 * names. The verifier stages only that check into the container, so a helper beside it would
 * pass intake and die at verification; anything else is not the draft's to write.
 */
function strayFile(
  draft: ReadonlyMap<string, string>,
  checkFile: string,
): DraftRefusal | undefined {
  for (const path of draft.keys()) {
    if (path === "task.json" || path === "spec.md" || path === "checks.json" || path === checkFile)
      continue
    return invalid(
      path.startsWith("checks/")
        ? `${DRAFT_ROOT}${path} is not the named check; a draft carries exactly one check file, under checks/`
        : `${DRAFT_ROOT}${path} is not one of task.json, spec.md, checks.json or the named check`,
    )
  }
  return undefined
}

/**
 * Turn what a drafter wrote under `draft/` into a task the catalog can load, or refuse it with
 * a reason that names the offending file. The controller fills what the drafter must not
 * decide: the id (the work order's) and the visible suite (the regression guard). Every rule
 * `loadTask` would apply later is applied here, so a materialised task is always loadable.
 */
export function parseDraft(
  files: ReadonlyMap<string, string>,
  input: { readonly workOrderId: string },
): ParseResult {
  const { workOrderId } = input
  if (!isCatalogId(workOrderId))
    return invalid(
      `work order id ${JSON.stringify(workOrderId)} is not a catalog id, so ${DRAFT_ROOT}task.json cannot be filled`,
    )
  const draft = new Map<string, string>()
  for (const [path, content] of files)
    if (path.startsWith(DRAFT_ROOT)) draft.set(path.slice(DRAFT_ROOT.length), content)
  const escaping = nonCanonicalKey(draft)
  if (escaping) return escaping

  const rawTask = readJson(draft, "task.json")
  if (rawTask.kind === "refusal") return rawTask.refusal
  const draftTask = DraftTaskSchema.safeParse(rawTask.value)
  if (!draftTask.success)
    return invalid(`${DRAFT_ROOT}task.json is invalid: ${describeIssues(draftTask.error)}`)
  const filled = TaskSchema.safeParse({
    id: workOrderId,
    target: draftTask.data.target,
    allowedSourcePaths: draftTask.data.allowedSourcePaths,
    immutablePaths: draftTask.data.immutablePaths,
  })
  if (!filled.success)
    return invalid(`${DRAFT_ROOT}task.json is invalid: ${describeIssues(filled.error)}`)
  const manifest = filled.data

  // Before checks.json on purpose: an unknown target is the least fixable defect, so its
  // refusal (`no_target_for_package`) wins on precedence over anything a redraft could mend.
  let target: ReturnType<typeof loadTarget>
  try {
    target = loadTarget(manifest.target)
  } catch (error) {
    return {
      ok: false,
      reason: `${DRAFT_ROOT}task.json names target ${JSON.stringify(manifest.target)}: ${error instanceof Error ? error.message : String(error)}`,
      blockedReason: "no_target_for_package",
    }
  }

  const rawChecks = readJson(draft, "checks.json")
  if (rawChecks.kind === "refusal") return rawChecks.refusal
  const draftChecks = DraftChecksSchema.safeParse(rawChecks.value)
  if (!draftChecks.success)
    return invalid(`${DRAFT_ROOT}checks.json is invalid: ${describeIssues(draftChecks.error)}`)
  const checks: Checks = { visible: REGRESSION_GUARD, independent: draftChecks.data.independent }
  try {
    assertTaskFitsTarget(workOrderId, manifest, checks, target)
  } catch (error) {
    return invalid(
      `${DRAFT_ROOT}task.json does not fit target ${manifest.target}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const specText = draft.get("spec.md")
  if (specText === undefined) return invalid(`${DRAFT_ROOT}spec.md is missing`)
  if (specText.trim().length === 0) return invalid(`${DRAFT_ROOT}spec.md is blank`)
  const acceptanceIds = acceptanceIdsOf(specText)
  if (acceptanceIds.length === 0)
    return invalid(`${DRAFT_ROOT}spec.md states no acceptance criteria (no \`A<n>:\` line)`)

  const unprefixed = checks.independent.assertions.filter((name) => !ACCEPTANCE_ID.test(name))
  if (unprefixed.length > 0)
    return invalid(
      `${DRAFT_ROOT}checks.json independent assertions must start with an acceptance id (\`A<n>:\`): ${unprefixed.map((name) => JSON.stringify(name)).join(", ")}`,
    )
  const checked = sortedSet(
    checks.independent.assertions.map((name) => name.match(ACCEPTANCE_ID)?.[1] ?? ""),
  )
  const stated = sortedSet(acceptanceIds)
  if (!sameSet(checked, stated))
    return invalid(
      `${DRAFT_ROOT}checks.json independent assertions cover [${checked.join(", ")}] but ${DRAFT_ROOT}spec.md states [${stated.join(", ")}]`,
    )

  if (!draft.has(checks.independent.file))
    return invalid(
      `${DRAFT_ROOT}checks.json names ${DRAFT_ROOT}${checks.independent.file}, which the draft does not contain`,
    )
  const stray = strayFile(draft, checks.independent.file)
  if (stray) return stray

  return { ok: true, manifest, checks, specText, acceptanceIds, files: draft }
}
