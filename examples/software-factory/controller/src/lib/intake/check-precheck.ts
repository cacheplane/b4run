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
  | "own-package-import"
  | "absolute-path"
  | "test-names"
  | "built-source"
  | "bin-entry"

export interface PrecheckViolation {
  readonly rule: PrecheckRule
  /** 1-based; absent when the rule is about the file as a whole. */
  readonly line?: number
  readonly detail: string
}

export interface PrecheckInput {
  readonly source: string
  /** The check's draft-relative path (`checks/<name>.test.ts`); relative specifiers resolve against it. */
  readonly file: string
  /** The independent suite's names from `checks.json`, whose `A<n>` ids the top-level tests must match. */
  readonly assertions: readonly string[]
  /**
   * The target runs its checks under a loader (`nodeTestExecArgv`, e.g. `--import tsx`), which
   * accepts syntax Node's own type stripper does not: the syntax rule is then not this
   * reading's to judge.
   */
  readonly skipSyntax?: boolean
  /**
   * The package under repair, by its `package.json` name: a bare import of it resolves to the
   * image's installed copy, never the workspace the build writes. Unknown: not checked.
   */
  readonly ownPackage?: string
  /**
   * The target's build output and the pin's source tree, for rules (f) and (g). Unknown: not
   * checked. Every path here is relative to the target root (the check's working directory).
   */
  readonly build?: BuildFacts
}

/** What a check's built-output locations are read against. */
export interface BuildFacts {
  /**
   * The build output prefixes (`snapshotIgnore` entries ending in `dist/`, e.g.
   * `packages/cli/dist/`). Each mirrors the sibling `src/` at the pin: `<pkg>/dist/<file>.js` is
   * built from `<pkg>/src/<file>.ts`. A prefix whose `src/` the pin does not hold is not read.
   */
  readonly prefixes: readonly string[]
  /** The pin's tree, target-root-relative ("" is the target root). */
  readonly tree: PinSource
  /** Built files a package's `bin` runs (the CLI entry), with the bin that runs each. */
  readonly entries?: readonly { readonly path: string; readonly bin: string }[]
}

/** The slice of `PinTree` the rules read: what is at a path, and what a directory holds. */
export interface PinSource {
  kind(path: string): "file" | "dir" | "link" | "submodule" | undefined
  children(dir: string): readonly { readonly name: string; readonly kind: string }[]
  files(path: string): readonly { readonly path: string }[]
}

const ACCEPTANCE_ID = /^(A\d+):/
/** The type stripper's two syntax errors; anything else it throws is not the draft's fault. */
const SYNTAX_ERRORS = new Set([
  "ERR_INVALID_TYPESCRIPT_SYNTAX",
  "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
])

/** The 1-based line of `index` in `text`. */
const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length

/** A runtime (not type-only) binding of `test` or `it` inside an import's braces. */
function bindsTest(braces: string): boolean {
  return braces
    .split(",")
    .map((part) => part.trim())
    .some((part) => /^(?:test|it)\b/.test(part))
}

/** Every import from `node:test`: its clause, and whether the whole import is type-only. */
const NODE_TEST_IMPORT = /\bimport\s+(type\s+)?([^;"'`]*?)\s+from\s*["']node:test["']/g

/** A static module specifier: `from "..."` (imports and re-exports) or a bare `import "..."`. */
const STATIC_SPECIFIER = /(?:\bfrom\s*|\bimport\s+)(["'])([^"'\n]*)\1/g
/** The calls that take a module or file location: their argument text is read balanced. */
const LOCATION_CALL = /\b(?:import|require)\s*\(|\bnew\s+URL\s*\(/g
/** A string literal naming a package's build output. */
const BUILT_ARTIFACT = /(["'`])[^"'`\n]*\bpackages\/[^/"'`\n]+\/dist\/[^"'`\n]*\1/
/** A variable holding the working directory, or a path joined onto it. */
const CWD_VARIABLE =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:process\.cwd\(\)|(?:join|resolve)\s*\(\s*process\.cwd\(\))/g
/** A string literal that is an absolute path inside the sandbox. */
const ABSOLUTE_WORKSPACE = /(["'`])\/workspace\/[^"'`\n]*\1/

/** A top-level `test(`/`it(` (or `nt.test(`) and the name it is given, at the start of a line. */
const TOP_LEVEL_TEST =
  /^(?:await\s+)?(?:[A-Za-z_$][\w$]*\.)?(?:test|it)\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/gm

/** The argument text of the call whose `(` is at `open`, up to its balancing `)`. */
function argumentsAt(source: string, open: number): string {
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (char === "(") depth += 1
    else if (char === ")") {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  return source.slice(open + 1)
}

/** `text` split at its top-level commas (outside parentheses, brackets, braces and strings). */
function splitArguments(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | undefined
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string
    if (quote !== undefined) {
      if (char === "\\") index += 1
      else if (char === quote) quote = undefined
    } else if (char === '"' || char === "'" || char === "`") quote = char
    else if ("([{".includes(char)) depth += 1
    else if (")]}".includes(char)) depth -= 1
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

/** The path calls whose result is their arguments joined (`resolve` from the working directory). */
const PATH_CALL = /^(?:(?:path|posix|nodePath)\.)?(?:join|resolve)\s*\(/
const PATH_LITERAL = /^(["'`])([^"'`\n]*)\1$/

/**
 * A location expression as a target-root-relative path: string literals, `process.cwd()` (the
 * target root), a variable `values` holds, `join(...)`/`resolve(...)` of those, and
 * `pathToFileURL(...)` (`.href`) around one. Anything else is undefined: not read.
 */
function evaluatePath(expression: string, values: ReadonlyMap<string, string>): string | undefined {
  const text = expression.trim()
  const literal = PATH_LITERAL.exec(text)
  if (literal !== null) {
    const value = literal[2] as string
    if (value.includes("${")) return undefined
    const normal = posix.normalize(value)
    return normal === "." ? "" : normal
  }
  if (/^process\.cwd\(\)$/.test(text)) return ""
  if (/^[A-Za-z_$][\w$]*$/.test(text)) return values.get(text)
  const url = /^(?:url\.)?pathToFileURL\s*\(/.exec(text)
  const call = url ?? PATH_CALL.exec(text)
  if (call === null) return undefined
  const open = call[0].length - 1
  const args = argumentsAt(text, open)
  const rest = text.slice(open + args.length + 2).trim()
  if (rest !== "" && !(url !== null && rest === ".href")) return undefined
  const parts = splitArguments(args).map((part) => evaluatePath(part, values))
  if (parts.length === 0 || parts.some((part) => part === undefined)) return undefined
  if (url !== null) return parts.length === 1 ? parts[0] : undefined
  const joined = posix.normalize(posix.join(...(parts as string[])))
  return joined === "." ? "" : joined
}

/** A declaration whose value may be a path: `const <name> = <expression>`, to its line's end. */
const PATH_DECLARATION = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g

/** The declaration's value: a balanced call (with a trailing `.href`), or a literal. */
function declarationValue(source: string, start: number): string {
  const call = /^(?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*\s*\(/.exec(source.slice(start))
  if (call !== null) {
    const open = start + call[0].length - 1
    const args = argumentsAt(source, open)
    const end = open + args.length + 2
    const href = source.slice(end).startsWith(".href") ? ".href" : ""
    return source.slice(start, end) + href
  }
  return /^(["'`])[^"'`\n]*\1/.exec(source.slice(start))?.[0] ?? ""
}

/** The source extensions a built file is compiled from, by the built extension. */
const SOURCES_OF: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx", ".js", ".jsx"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
}
const BUILT_OF: Readonly<Record<string, string>> = {
  ".ts": ".js",
  ".tsx": ".js",
  ".js": ".js",
  ".jsx": ".js",
  ".mts": ".mjs",
  ".cts": ".cjs",
}
const MAX_LISTED = 15

/**
 * (f) Whether the pin holds the source `path` (under a build prefix) is built from; undefined
 * when it does, or when the path is not one this rule reads (another extension, the prefix's
 * own directory, a prefix whose `src/` the pin does not hold). The refusal names the
 * specifier, the source looked for, and what is there instead.
 */
function missingSource(
  path: string,
  build: BuildFacts,
  form: "import" | "value",
): string | undefined {
  const prefix = build.prefixes.find((p) => path.startsWith(p))
  if (prefix === undefined) return undefined
  const rest = path.slice(prefix.length)
  if (rest === "") return undefined
  const srcRoot = `${prefix.slice(0, -"dist/".length)}src/`
  if (build.tree.kind(srcRoot.slice(0, -1)) !== "dir") return undefined
  const extension = posix.extname(rest)
  let looked: string[]
  let named: string
  if (extension === "") {
    // A directory: imported, its `index`; held in a variable, the directory itself.
    looked = [`${srcRoot}${rest}/index.ts`, `${srcRoot}${rest}/index.tsx`]
    named = `${srcRoot}${rest}/index.ts (or .tsx)`
    if (form === "value" && build.tree.kind(`${srcRoot}${rest}`) === "dir") return undefined
  } else {
    const sources = SOURCES_OF[extension]
    if (sources === undefined) return undefined
    const stem = rest.slice(0, -extension.length)
    looked = sources.map((ext) => `${srcRoot}${stem}${ext}`)
    named = `${looked[0]} (or ${sources.slice(1).join(", ")})`
  }
  if (looked.some((candidate) => build.tree.kind(candidate) === "file")) return undefined

  const builtOf = (source: string) => {
    const ext = posix.extname(source)
    return `${prefix}${source.slice(srcRoot.length, -ext.length)}${BUILT_OF[ext] ?? ext}`
  }
  // The same module name elsewhere under src/ is the likeliest meaning; failing that, what the
  // nearest directory that exists holds.
  const stem = posix.basename(rest, extension)
  const namesake = build.tree
    .files(srcRoot.slice(0, -1))
    .map((file) => file.path)
    .filter((file) => {
      const ext = posix.extname(file)
      return (
        BUILT_OF[ext] !== undefined &&
        !file.endsWith(".d.ts") &&
        (posix.basename(file, ext) === stem || file.endsWith(`/${stem}/index${ext}`))
      )
    })
    .slice(0, 3)
  let hint: string
  if (namesake.length > 0)
    hint = `did you mean ${namesake.map((file) => JSON.stringify(builtOf(file))).join(" or ")} (built from ${namesake.join(", ")})`
  else {
    let dir = posix.dirname(`${srcRoot}${rest}`)
    while (dir.length >= srcRoot.length - 1 && build.tree.kind(dir) !== "dir")
      dir = posix.dirname(dir)
    const entries = build.tree
      .children(dir)
      .filter((entry) => entry.kind === "dir" || BUILT_OF[posix.extname(entry.name)] !== undefined)
      .filter((entry) => !entry.name.endsWith(".d.ts"))
      .map((entry) => (entry.kind === "dir" ? `${entry.name}/` : entry.name))
    hint = `${dir}/ holds ${entries.slice(0, MAX_LISTED).join(", ")}${entries.length > MAX_LISTED ? `, and ${entries.length - MAX_LISTED} more` : ""}`
  }
  return `${JSON.stringify(path)} is not built from anything at the pin: the build mirrors ${srcRoot} into ${prefix}, and the pin holds no ${named}; ${hint}. List repo/${srcRoot} before naming a built file`
}

/** Every rule `input.source` breaks, sorted by line. */
export function precheckDraftedCheck(input: PrecheckInput): PrecheckViolation[] {
  const { source, file, assertions } = input
  const violations: PrecheckViolation[] = []

  // (d) It must parse. Node's own type stripper (the one that will run the check) parses
  // TypeScript and ESM; its error carries the line as `:<n>` at the top of its stack.
  if (!input.skipSyntax) {
    try {
      stripTypeScriptTypes(source)
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (typeof code !== "string" || !SYNTAX_ERRORS.has(code)) throw error
      const stack = error instanceof Error ? (error.stack ?? "") : ""
      const line = /^[^\n]*:(\d+)\n/.exec(stack)?.[1]
      violations.push({
        rule: "syntax",
        ...(line !== undefined ? { line: Number(line) } : {}),
        detail: `the check does not parse as TypeScript: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  // (a) `test` (or `it`) must come from `node:test` at run time: the runner is node's, and there
  // is no global. A default import binds `test`, a namespace binds both; a type-only import
  // binds nothing.
  let binds = false
  let typeOnly: number | undefined
  for (const match of source.matchAll(NODE_TEST_IMPORT)) {
    const clause = (match[2] as string).trim()
    if (match[1] !== undefined) {
      typeOnly ??= match.index
      continue
    }
    const braces = /\{([^}]*)\}/.exec(clause)?.[1]
    const outside = clause
      .replace(/\{[^}]*\}/, "")
      .replace(/,/g, "")
      .trim()
    if (outside.length > 0 || (braces !== undefined && bindsTest(braces))) binds = true
  }
  if (!binds)
    violations.push({
      rule: "node-test-import",
      ...(typeOnly !== undefined ? { line: lineAt(source, typeOnly) } : {}),
      detail:
        typeOnly !== undefined
          ? '`import type` from "node:test" binds no runtime `test`; write `import { test } from "node:test"`'
          : 'the check never imports `test` from "node:test" (`import { test } from "node:test"`); node has no global `test`, so the file fails to load',
    })

  // The module locations the check names: static specifiers, and the argument text of every
  // `import(`, `require(` and `new URL(`. Comments, assertion messages and a `spawnSync` argv
  // are not locations, and are not read.
  const locations: { index: number; specifier?: string; args?: string }[] = []
  for (const match of source.matchAll(STATIC_SPECIFIER))
    locations.push({ index: match.index, specifier: match[2] as string })
  for (const match of source.matchAll(LOCATION_CALL)) {
    const args = argumentsAt(source, match.index + match[0].length - 1)
    const literal = /^\s*(["'`])([^"'`\n]*)\1\s*(?:,|$)/.exec(args)?.[2]
    locations.push({
      index: match.index,
      args,
      ...(literal !== undefined ? { specifier: literal } : {}),
    })
  }
  const cwdNames = [...source.matchAll(CWD_VARIABLE)].map((m) => m[1] as string)
  const throughCwd = (text: string) =>
    /process\.cwd\(\)/.test(text) ||
    cwdNames.some((name) => new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`).test(text))

  // The paths the check's declarations hold, in source order, so one may build on another.
  const build = input.build
  const pathValues = new Map<string, string>()
  const declarations: { line: number; value: string }[] = []
  for (const match of source.matchAll(PATH_DECLARATION)) {
    const value = evaluatePath(declarationValue(source, match.index + match[0].length), pathValues)
    if (value === undefined) continue
    pathValues.set(match[1] as string, value)
    declarations.push({ line: lineAt(source, match.index), value })
  }
  const checked = new Set<string>()

  const directory = posix.dirname(file)
  for (const location of locations) {
    const line = lineAt(source, location.index)
    const specifier = location.specifier
    // (b) A relative specifier resolves against the check file, which the verifier stages
    // under `checks/`: anything reaching outside it (the build, `repo/`) does not exist there.
    if (specifier !== undefined && /^\.\.?\//.test(specifier)) {
      const resolved = posix.normalize(posix.join(directory, specifier))
      if (resolved !== directory && !resolved.startsWith(`${directory}/`))
        violations.push({
          rule: "relative-import",
          line,
          detail: `the relative specifier ${JSON.stringify(specifier)} resolves to ${JSON.stringify(resolved)}, outside ${directory}/ where the check runs; load the build with \`await import(join(process.cwd(), "packages/<name>/dist/<file>.js"))\``,
        })
    }
    // A bare import of the package under repair resolves to the image's installed copy, not
    // the workspace its build writes.
    if (
      specifier !== undefined &&
      input.ownPackage !== undefined &&
      (specifier === input.ownPackage || specifier.startsWith(`${input.ownPackage}/`))
    )
      violations.push({
        rule: "own-package-import",
        line,
        detail: `${JSON.stringify(specifier)} imports the package under repair by name, which resolves to the image's installed copy, not the build of the repair; load it with \`await import(join(process.cwd(), "packages/<name>/dist/<file>.js"))\``,
      })
    // An absolute sandbox path as a module location hard-codes where the verifier happens to
    // stage the workspace. The same string as data (a CLI argument) is not a location.
    const absolute = ABSOLUTE_WORKSPACE.exec(location.args ?? JSON.stringify(specifier ?? ""))
    if (absolute !== null)
      violations.push({
        rule: "absolute-path",
        line,
        detail: `${absolute[0]} loads from an absolute path inside the sandbox; reach the target root through process.cwd()`,
      })
    // (c) The build output is reached through the working directory (the target root): a
    // location naming `packages/<name>/dist/` that does not go through `process.cwd()` (or a
    // variable holding it) is resolved against something else.
    const text = location.args ?? JSON.stringify(specifier ?? "")
    if (BUILT_ARTIFACT.test(text) && (location.args === undefined || !throughCwd(text)))
      violations.push({
        rule: "cwd-artifact",
        line,
        detail: `${(BUILT_ARTIFACT.exec(text) as RegExpExecArray)[0]} names the build output but is not joined onto process.cwd(); write \`join(process.cwd(), "packages/<name>/dist/<file>.js")\``,
      })
    if (build !== undefined) {
      const first = location.args !== undefined ? splitArguments(location.args)[0] : undefined
      const path = first !== undefined ? evaluatePath(first, pathValues) : (specifier ?? undefined)
      if (path !== undefined) {
        // (f) The built file a location names is compiled from a source the pin holds.
        const missing = missingSource(path, build, "import")
        if (missing !== undefined) {
          checked.add(path)
          violations.push({ rule: "built-source", line, detail: missing })
        }
        // (g) Not the CLI's entry: importing it loads the whole program (and its argv
        // handling) to reach one function, which is what hung the live run's proof.
        const entry = build.entries?.find((e) => e.path === path)
        if (entry !== undefined)
          violations.push({
            rule: "bin-entry",
            line,
            detail: `${JSON.stringify(path)} is the CLI entry (${entry.bin} runs it); import the module under ${posix.dirname(path)}/ that owns the behaviour under test, built from its file under the package's src/`,
          })
      }
    }
  }

  // (f), for a path held in a variable (`const dist = join(process.cwd(), "...")`), which a
  // template or a later `join(dist, ...)` uses where a location is not read.
  if (build !== undefined)
    for (const declared of declarations) {
      if (checked.has(declared.value)) continue
      const missing = missingSource(declared.value, build, "value")
      if (missing !== undefined)
        violations.push({ rule: "built-source", line: declared.line, detail: missing })
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

/** Every character a RegExp treats specially, escaped: a name is data, never pattern. */
function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")
}
