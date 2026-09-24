import { stripTypeScriptTypes } from "node:module"
import { posix } from "node:path"

/**
 * A static reading of a drafted check, in milliseconds, before the controller spends a
 * container session proving it as an oracle. The rerun of issue 714 (`wo-c7cbe172b6017faf`)
 * spent three drafter attempts, about ten minutes each, to learn one defect per proof: a
 * check that imported the build through `../repo/...` (twice), then one that never imported
 * `test` from `node:test`. Each is visible in the file's text. A violation refuses the draft as
 * `intake_invalid`, which spends an attempt like any refused draft, with every rule broken
 * named with its line so the redraft can mend all of them at once.
 *
 * The rules are heuristics over the source, not a type check: they refuse the shapes that
 * cannot work and admit anything else, which the oracle proof then judges.
 */

export type PrecheckRule =
  | "syntax"
  | "node-test-import"
  | "relative-import"
  | "cwd-artifact"
  | "test-names"

export interface PrecheckViolation {
  readonly rule: PrecheckRule
  /** 1-based; absent when the rule is about the file as a whole. */
  readonly line?: number
  readonly detail: string
}

const ACCEPTANCE_ID = /^(A\d+):/

/** The 1-based line of `index` in `text`. */
const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length

/**
 * `test` from `node:test`, in any of the forms that bind it: a named import (renamed or not),
 * the default export (which is `test`), or a namespace (`nt.test(...)`).
 */
const NODE_TEST_IMPORT = [
  /\bimport\s*(?:type\s+)?\{[^}]*\btest\b[^}]*\}\s*from\s*["']node:test["']/,
  /\bimport\s+[A-Za-z_$][\w$]*\s*(?:,\s*\{[^}]*\})?\s*from\s*["']node:test["']/,
  /\bimport\s*\*\s*as\s+[A-Za-z_$][\w$]*\s+from\s*["']node:test["']/,
]

/** A relative module specifier: static and dynamic imports, re-exports, `require`, `new URL`. */
const RELATIVE_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bnew\s+URL\s*\(\s*)(["'`])(\.\.?\/[^"'`\n]*)\1/g

/** A string literal naming a package's build output. */
const BUILT_ARTIFACT = /(["'`])[^"'`\n]*\bpackages\/[^/"'`\n]+\/dist\/[^"'`\n]*\1/g
/** The one way a check reaches the target root: through its working directory. */
const THROUGH_CWD = /\b(?:join|resolve)\s*\(\s*process\.cwd\(\)\s*,/

/** A top-level `test(` (or `nt.test(`) and the name it is given, at the start of a line. */
const TOP_LEVEL_TEST =
  /^(?:await\s+)?(?:[A-Za-z_$][\w$]*\.)?test\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/gm

/**
 * Every rule `source` breaks. `file` is the check's draft-relative path (`checks/<name>.test.ts`),
 * which a relative specifier is resolved against; `assertions` are the independent suite's
 * names from `checks.json`, whose `A<n>` ids the top-level tests must match.
 */
export function precheckDraftedCheck(input: {
  readonly source: string
  readonly file: string
  readonly assertions: readonly string[]
}): PrecheckViolation[] {
  const { source, file, assertions } = input
  const violations: PrecheckViolation[] = []

  // (d) It must parse. Node's own type stripper (the one that will run the check) parses
  // TypeScript and ESM; its error carries the line as `:<n>` at the top of its stack.
  try {
    stripTypeScriptTypes(source)
  } catch (error) {
    const stack = error instanceof Error ? (error.stack ?? "") : ""
    const line = /^[^\n]*:(\d+)\n/.exec(stack)?.[1]
    violations.push({
      rule: "syntax",
      ...(line !== undefined ? { line: Number(line) } : {}),
      detail: `the check does not parse as TypeScript: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  // (a) `test` must come from `node:test`: the runner is node's, and there is no global.
  if (!NODE_TEST_IMPORT.some((pattern) => pattern.test(source)))
    violations.push({
      rule: "node-test-import",
      detail:
        'the check never imports `test` from "node:test" (`import { test } from "node:test"`); node has no global `test`, so the file fails to load',
    })

  // (b) A relative specifier resolves against the check file, which the verifier stages under
  // `checks/`: anything reaching outside it (the build, `repo/`) does not exist there.
  const directory = posix.dirname(file)
  for (const match of source.matchAll(RELATIVE_SPECIFIER)) {
    const specifier = match[2] as string
    const resolved = posix.normalize(posix.join(directory, specifier))
    if (resolved === directory || resolved.startsWith(`${directory}/`)) continue
    violations.push({
      rule: "relative-import",
      line: lineAt(source, match.index),
      detail: `the relative specifier ${JSON.stringify(specifier)} resolves to ${JSON.stringify(resolved)}, outside ${directory}/ where the check runs; load the build with \`await import(join(process.cwd(), "packages/<name>/dist/<file>.js"))\``,
    })
  }

  // (c) The built artifact is reached through the working directory (the target root), and
  // only that way: a path to `packages/<name>/dist/` on a line that does not join it onto
  // `process.cwd()` is resolved against something else.
  const lines = source.split("\n")
  for (const match of source.matchAll(BUILT_ARTIFACT)) {
    const line = lineAt(source, match.index)
    if (THROUGH_CWD.test(lines[line - 1] ?? "")) continue
    violations.push({
      rule: "cwd-artifact",
      line,
      detail: `${match[0]} names the build output but is not joined onto process.cwd(); write \`join(process.cwd(), "packages/<name>/dist/<file>.js")\``,
    })
  }

  // (e) The top-level tests are the assertions checks.json names, by acceptance id: the
  // grading matches failures to `A<n>` by name, so a test the manifest does not list (or one
  // it lists that no test runs) cannot be the evidence it claims.
  const tested: string[] = []
  let topLevel = 0
  for (const match of source.matchAll(TOP_LEVEL_TEST)) {
    topLevel += 1
    const id = (match[2] as string).match(ACCEPTANCE_ID)?.[1]
    if (id === undefined)
      violations.push({
        rule: "test-names",
        line: lineAt(source, match.index),
        detail: `the top-level test ${JSON.stringify(match[2])} does not start with an acceptance id (\`A<n>: ...\`)`,
      })
    else tested.push(id)
  }
  const listed = assertions.flatMap((name) => name.match(ACCEPTANCE_ID)?.[1] ?? [])
  const unique = (values: readonly string[]) => [...new Set(values)].sort()
  const missing = unique(listed).filter((id) => !tested.includes(id))
  const extra = unique(tested).filter((id) => !listed.includes(id))
  if (topLevel === 0)
    violations.push({
      rule: "test-names",
      detail: 'the check has no top-level `test("A<n>: ...", ...)` at the start of a line',
    })
  else if (tested.length > 0 && (missing.length > 0 || extra.length > 0))
    violations.push({
      rule: "test-names",
      detail: `the top-level tests name [${unique(tested).join(", ")}] but checks.json lists [${unique(listed).join(", ")}]${missing.length ? `: no test for ${missing.join(", ")}` : ""}${extra.length ? `: ${extra.join(", ")} not listed` : ""}`,
    })

  return violations.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
}

/** One refusal line for the draft: every violation, rule and line first. */
export function describePrecheck(file: string, violations: readonly PrecheckViolation[]): string {
  return `draft/${file} fails the static pre-check (${violations.length} ${violations.length === 1 ? "problem" : "problems"}): ${violations
    .map((v) => `[${v.rule}${v.line !== undefined ? ` line ${v.line}` : ""}] ${v.detail}`)
    .join("; ")}`
}
