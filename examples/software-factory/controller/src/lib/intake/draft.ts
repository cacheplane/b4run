import { execFileSync } from "node:child_process"
import { z } from "zod"
import {
  assertTaskFitsTarget,
  type CatalogOptions,
  type Checks,
  ChecksSchema,
  commitSha,
  covers,
  isCatalogId,
  loadTargetRecipe,
  relativePath,
  repositoryRoot,
  requiredImmutablePaths,
  type TargetRecipe,
  TaskFieldsSchema,
  type TaskManifest,
  TaskSchema,
  UnknownTargetError,
  unmeasuredProblem,
} from "../targets/catalog.js"
import { recipeProblem } from "../targets/prepare.js"
import { describePrecheck, precheckDraftedCheck } from "./check-precheck.js"

/** Where the drafter writes, relative to its workspace. Keys outside it are not the draft. */
export const DRAFT_ROOT = "draft/"

/** The draft's own checks manifest: the independent suite only. The visible suite is the controller's. */
const DraftChecksSchema = z.object({ independent: ChecksSchema.shape.independent }).strict()
/**
 * The draft's task manifest: everything but the id and the pin, which are the work order's.
 * A drafter that writes a `pin` is refused by the strict schema: the pin is what the work
 * order was created at, never something the draft may choose.
 */
const DraftTaskSchema = TaskFieldsSchema.omit({ id: true, pin: true }).strict()

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
  /** The drafted target at the work order's pin, without an image: intake builds that next. */
  readonly target: TargetRecipe
  /** Every `draft/`-relative file, for materialisation: the three manifests and the one check. */
  readonly files: ReadonlyMap<string, string>
}
export type DraftRefusal = {
  readonly ok: false
  readonly reason: string
  /**
   * `intake_run_failed` is not a verdict on the draft: the catalog could not be read, or the
   * pin could not be made present. The caller blocks without spending a drafter attempt.
   */
  readonly blockedReason: "intake_invalid" | "no_target_for_package" | "intake_run_failed"
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
 * The refusal for a spec and a check that disagree on their acceptance ids. It teaches the
 * rule rather than only the mismatch: the live run's drafter stated scope ("only this file
 * changes") as an `A<n>` no test can assert, was refused, and on the retry wrote it again.
 */
export function acceptanceMismatch(stated: readonly string[], checked: readonly string[]): string {
  const missing = stated.filter((id) => !checked.includes(id))
  const extra = checked.filter((id) => !stated.includes(id))
  const gap = [
    ...(missing.length ? [`states [${missing.join(", ")}] that no assertion covers`] : []),
    ...(extra.length ? [`does not state [${extra.join(", ")}] that an assertion names`] : []),
  ].join(" and ")
  return (
    `${DRAFT_ROOT}spec.md states [${stated.join(", ")}] but the check asserts [${checked.join(", ")}] ` +
    `(the spec ${gap}): every A<n> must be an observable behaviour asserted by one top-level ` +
    `test named 'A<n>: ...' in the check and listed in ${DRAFT_ROOT}checks.json; state scope ` +
    `(what the repair may change) in ${DRAFT_ROOT}task.json allowedSourcePaths and ` +
    `immutablePaths, not as an acceptance criterion`
  )
}

/**
 * The `name` in `<cwd>/package.json` at `pin`: the package under repair, which a check must
 * not import by name. Undefined when it cannot be read (the pre-check then skips that rule):
 * the pin was made present by `loadTarget`, so this is a local `git show`.
 */
function packageNameAt(root: string | undefined, pin: string, cwd: string): string | undefined {
  try {
    const path = cwd === "." ? "package.json" : `${cwd}/package.json`
    const text = execFileSync("git", ["-C", root ?? repositoryRoot(), "show", `${pin}:${path}`], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const name = (JSON.parse(text) as { name?: unknown }).name
    return typeof name === "string" && name.length > 0 ? name : undefined
  } catch {
    return undefined
  }
}

/**
 * Turn what a drafter wrote under `draft/` into a task the catalog can load, or refuse it with
 * a reason that names the offending file. The controller fills what the drafter must not
 * decide: the id and the pin (the work order's), the visible suite (the regression guard),
 * and the target's runner configuration among the immutable paths.
 * Every rule `loadTask` would apply later is applied here, so a materialised task is always
 * loadable, at the work order's pin. `catalog` is where the target is looked up (the shipped
 * catalog by default); its own `pin`, if any, is ignored for the work order's.
 */
export function parseDraft(
  files: ReadonlyMap<string, string>,
  input: {
    readonly workOrderId: string
    readonly pin: string
    /** Test-only: the catalog to look the target up in; the shipped one otherwise. */
    readonly catalog?: Pick<CatalogOptions, "targetsDir" | "repositoryRoot">
  },
): ParseResult {
  const { workOrderId, pin } = input
  if (!isCatalogId(workOrderId))
    return invalid(
      `work order id ${JSON.stringify(workOrderId)} is not a catalog id, so ${DRAFT_ROOT}task.json cannot be filled`,
    )
  // The caller's pin, not the draft's: a malformed one is a fault of the caller, reported as
  // such, never a refusal the drafter could mend.
  if (!commitSha.safeParse(pin).success)
    throw new Error(`parseDraft: work order ${workOrderId} has no valid pin (${String(pin)})`)
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
    pin,
    allowedSourcePaths: draftTask.data.allowedSourcePaths,
    immutablePaths: draftTask.data.immutablePaths,
  })
  if (!filled.success)
    return invalid(`${DRAFT_ROOT}task.json is invalid: ${describeIssues(filled.error)}`)
  const drafted = filled.data

  // Before checks.json on purpose: an unknown target, or one whose files are not at the work
  // order's pin, is the least fixable defect, so its refusal (`no_target_for_package`) wins on
  // precedence over anything a redraft could mend. Whether this host has an image of it is not
  // asked here: intake builds one at the fit step.
  let target: TargetRecipe
  try {
    target = loadTargetRecipe(drafted.target, { ...input.catalog, pin })
  } catch (error) {
    if (error instanceof UnknownTargetError)
      return {
        ok: false,
        reason: `${DRAFT_ROOT}task.json names target ${JSON.stringify(drafted.target)}: ${error.message}`,
        blockedReason: "no_target_for_package",
      }
    // Anything else is the controller's own trouble, not the draft's: a manifest it could
    // not read or parse (a bad edit), or a pin it could not fetch.
    return {
      ok: false,
      reason: `target ${JSON.stringify(drafted.target)} could not be loaded at ${pin}: ${error instanceof Error ? error.message : String(error)}`,
      blockedReason: "intake_run_failed",
    }
  }
  const inapplicable =
    unmeasuredProblem(target) ??
    recipeProblem(target, input.catalog?.repositoryRoot ?? repositoryRoot())
  if (inapplicable !== undefined)
    return {
      ok: false,
      reason: `${DRAFT_ROOT}task.json names target ${target.id}, which is not available at ${pin}: ${inapplicable}`,
      blockedReason: "no_target_for_package",
    }

  const rawChecks = readJson(draft, "checks.json")
  if (rawChecks.kind === "refusal") return rawChecks.refusal
  const draftChecks = DraftChecksSchema.safeParse(rawChecks.value)
  if (!draftChecks.success)
    return invalid(`${DRAFT_ROOT}checks.json is invalid: ${describeIssues(draftChecks.error)}`)
  const checks: Checks = { visible: REGRESSION_GUARD, independent: draftChecks.data.independent }
  // The target's runner configuration is controller-owned policy, like the id and the pin: it
  // is filled in, after the drafter's own entries, rather than asked of a drafter that cannot
  // know it. What stays a refusal is an allowed path that reaches it.
  const immutablePaths = [...drafted.immutablePaths]
  for (const path of requiredImmutablePaths(checks, target))
    if (!covers(immutablePaths, path)) immutablePaths.push(path)
  const manifest: TaskManifest = { ...drafted, immutablePaths }
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
  if (!sameSet(checked, stated)) return invalid(acceptanceMismatch(stated, checked))

  if (!draft.has(checks.independent.file))
    return invalid(
      `${DRAFT_ROOT}checks.json names ${DRAFT_ROOT}${checks.independent.file}, which the draft does not contain`,
    )
  const stray = strayFile(draft, checks.independent.file)
  if (stray) return stray

  // Last, and before any container is started: the check's own text, read statically. What it
  // refuses would otherwise take a whole oracle proof (minutes) to find, one defect at a time.
  const ownPackage = packageNameAt(input.catalog?.repositoryRoot, pin, target.commands.cwd)
  const violations = precheckDraftedCheck({
    source: draft.get(checks.independent.file) as string,
    file: checks.independent.file,
    assertions: checks.independent.assertions,
    // A loader (`--import tsx`) accepts syntax node's own stripper does not.
    skipSyntax: target.commands.nodeTestExecArgv.length > 0,
    ...(ownPackage !== undefined ? { ownPackage } : {}),
  })
  if (violations.length > 0) return invalid(describePrecheck(checks.independent.file, violations))

  return { ok: true, manifest, checks, specText, acceptanceIds, target, files: draft }
}
