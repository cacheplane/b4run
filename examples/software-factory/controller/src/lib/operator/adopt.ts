import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, posix } from "node:path"
import { promisify } from "node:util"

/**
 * `factory adopt <id>`: the hand-off spec §11 asks of a person, done for them, on their side
 * of the trust boundary. The factory's output stays exactly the approved bytes (the delivered
 * commit is cherry-picked, its author the app); what the factory could never add — a
 * changeset, a regression test in the package's own suite — is the person's commit on the
 * person's branch, pushed and opened with the person's `gh`. The app, its token and its
 * confined branches play no part.
 *
 * Nothing here verifies locally: the person's PR runs every lane, which is the point of the
 * person's PR, and a promoted test that fails there is theirs to fix on their own branch.
 */

const execFileAsync = promisify(execFile)

/** What the CLI resolves from the registry, the generated task and the checkout. */
export interface AdoptInput {
  readonly workOrderId: string
  /** `owner/name`, the delivery's repository. */
  readonly repository: string
  readonly baseBranch: string
  /** The factory's branch, `factory/<id>`, and the commit it holds. */
  readonly factoryBranch: string
  readonly headSha: string
  readonly factoryPullRequest: { readonly number: number; readonly url: string }
  readonly issue: { readonly number: number; readonly title: string }
  /** The target's `commands.cwd` (`packages/devkit`, or `.`). */
  readonly packageDir: string
  /** The independent check: its task-relative path and its text. */
  readonly check: { readonly file: string; readonly source: string }
  readonly bundleDigest: string
  readonly receiptId: string
  readonly verifierIdentity: string
  /** The operator's checkout (`FACTORY_REPO_ROOT`); its working tree is never touched. */
  readonly repositoryRoot: string
  readonly branch?: string
  readonly openPullRequest: boolean
  readonly closeFactoryPullRequest: boolean
}

export interface AdoptDeps {
  /** The `gh` executable (`FACTORY_GH` in the CLI, so a test can stub it). */
  readonly gh: string
  readonly exec?: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly input?: string },
  ) => Promise<{ readonly stdout: string }>
}

export interface AdoptResult {
  readonly ok: true
  readonly branch: string
  readonly commit: string
  readonly changeset: string | null
  /** The promoted test's repository path, or why none was written. */
  readonly promoted: { readonly path: string } | { readonly skipped: string }
  readonly pullRequest: { readonly url: string } | null
  readonly factoryPullRequest: { readonly number: number; readonly closed: boolean }
}

export class AdoptError extends Error {}

/** `# <title> (<owner/name>#<n>)`, as intake writes `issue.md`'s first line. */
export function issueTitleFrom(issueMd: string, repository: string, number: number): string {
  const first = issueMd.split("\n", 1)[0] ?? ""
  const suffix = ` (${repository}#${number})`
  const heading = first.startsWith("# ") ? first.slice(2) : first
  return (heading.endsWith(suffix) ? heading.slice(0, -suffix.length) : heading).trim()
}

export function adoptBranchName(workOrderId: string): string {
  return `adopt/${workOrderId}`
}

/** `.changeset/factory-<id>.md`: a patch (the fixed 0.x group), the issue's title, a `Refs` line. */
export function changesetFor(input: {
  readonly workOrderId: string
  readonly packageName: string
  readonly title: string
  readonly issueNumber: number
}): { readonly path: string; readonly text: string } {
  const title = input.title.replace(/\s+/g, " ").trim()
  return {
    path: `.changeset/factory-${input.workOrderId}.md`,
    text: `---\n${JSON.stringify(input.packageName)}: patch\n---\n\n${title}. Refs #${input.issueNumber}.\n`,
  }
}

const NODE_TEST_TO_VITEST: Readonly<Record<string, string>> = {
  test: "test",
  it: "it",
  describe: "describe",
  before: "beforeAll",
  after: "afterAll",
  beforeEach: "beforeEach",
  afterEach: "afterEach",
}

export type Promotion =
  | { readonly ok: true; readonly path: string; readonly source: string }
  | { readonly ok: false; readonly reason: string }

/**
 * The independent check, as the package's own vitest would run it: `node:test`'s names become
 * vitest's (`after` → `afterAll`), and the built-artifact import the check reaches through
 * `process.cwd()` becomes the source import a test file uses (`../src/<file>.ts`). Anything
 * the translation cannot express — another `node:test` export, a `require`, a `process.cwd()`
 * or `dist/` reference left over — is refused with the reason, and the person writes the test.
 */
export function promoteCheck(input: {
  readonly packageDir: string
  readonly checkFile: string
  readonly source: string
}): Promotion {
  const packageDir = posix.normalize(input.packageDir).replace(/\/$/, "")
  if (packageDir === "." || packageDir === "")
    return {
      ok: false,
      reason: "the target is the repository root, not a package with a test suite",
    }
  const testDir = `${packageDir}/test`
  let source = input.source

  // 1. node:test → vitest.
  const imports = [...source.matchAll(/^import\s+([^;\n]+?)\s+from\s+["']node:test["'];?\s*$/gm)]
  if (imports.length === 0) return { ok: false, reason: "the check does not import node:test" }
  const names = new Set<string>()
  for (const match of imports) {
    const clause = (match[1] as string).trim()
    // `test`, `test, { after }`, `{ test, after }`.
    const braces = clause.match(/\{([^}]*)\}/)
    const named = (braces?.[1] ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
    const defaults = clause
      .replace(/\{[^}]*\}/, "")
      .replace(/,/g, " ")
      .trim()
    if (defaults.length > 0) names.add(defaults === "test" ? "test" : `default:${defaults}`)
    for (const entry of named) {
      if (entry.includes(" as "))
        return { ok: false, reason: `node:test import \`${entry}\` is aliased` }
      names.add(entry)
    }
  }
  const vitestNames = new Set<string>()
  for (const name of names) {
    if (name.startsWith("default:"))
      return { ok: false, reason: `node:test is imported as \`${name.slice(8)}\`, not \`test\`` }
    const mapped = NODE_TEST_TO_VITEST[name]
    if (mapped === undefined)
      return { ok: false, reason: `node:test's \`${name}\` has no vitest form` }
    vitestNames.add(mapped)
  }
  for (const match of imports) source = source.replace(match[0], "")
  for (const [from, to] of Object.entries(NODE_TEST_TO_VITEST))
    if (from !== to && names.has(from))
      source = source.replace(new RegExp(`(?<![\\w.$])${from}(?=\\s*\\()`, "g"), to)

  // 2. The built artifact → the source. One form is understood: the one the drafter is told
  //    to write (`join(process.cwd(), "packages/<name>/dist/<file>.js")`), bound by
  //    destructuring or to one name.
  const dist = new RegExp(
    String.raw`^[ \t]*const\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*await\s+import\(\s*join\(\s*process\.cwd\(\)\s*,\s*["']${packageDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/dist/([^"']+?)\.js["']\s*\)\s*\)\s*;?[ \t]*$`,
    "gm",
  )
  const sourceImports: string[] = []
  source = source.replace(dist, (_whole, binding: string, rest: string) => {
    const target = posix.relative(testDir, `${packageDir}/src/${rest}.ts`)
    const specifier = target.startsWith(".") ? target : `./${target}`
    sourceImports.push(
      binding.startsWith("{")
        ? `import ${binding.replace(/\s+/g, " ")} from ${JSON.stringify(specifier)}`
        : `import * as ${binding} from ${JSON.stringify(specifier)}`,
    )
    return ""
  })
  if (sourceImports.length === 0)
    return {
      ok: false,
      reason:
        'no `await import(join(process.cwd(), "<package>/dist/<file>.js"))` to turn into a source import',
    }
  if (/process\.cwd\(\)/.test(source))
    return {
      ok: false,
      reason:
        "the check still reaches through process.cwd() after its artifact import was rewritten",
    }
  if (/\/dist\//.test(source)) return { ok: false, reason: "the check still names a dist/ path" }
  if (/\brequire\s*\(/.test(source)) return { ok: false, reason: "the check uses require()" }

  // 3. Assemble: vitest's import first, then the source import(s), then the rest, with the
  //    `join` import dropped when nothing uses it any more.
  const vitestImport = `import { ${[...vitestNames].sort().join(", ")} } from "vitest"`
  let body = source.replace(/^\n+/, "")
  if (!/\bjoin\s*\(/.test(body))
    body = body.replace(/^import\s+\{\s*join\s*\}\s+from\s+["']node:path["'];?\s*\n/m, "")
  body = body.replace(/\n{3,}/g, "\n\n")
  const text = `${vitestImport}\n${sourceImports.join("\n")}\n${body.startsWith("import") ? "" : "\n"}${body}`
  return { ok: true, path: `${testDir}/${basename(input.checkFile)}`, source: text }
}

export function adoptCommitMessage(input: {
  readonly title: string
  readonly issueNumber: number
  readonly factoryPullRequest: number
  readonly workOrderId: string
  readonly changeset: string | null
  readonly promoted: string | null
}): string {
  const added = [
    input.changeset ? `a changeset (${input.changeset})` : null,
    input.promoted ? `the factory's independent check as ${input.promoted}` : null,
  ].filter((part): part is string => part !== null)
  return [
    `${input.title} (#${input.issueNumber})`,
    "",
    `Adopted from the factory's draft PR #${input.factoryPullRequest} (work order ${input.workOrderId}): the delivered commit, cherry-picked${added.length > 0 ? `, plus ${added.join(" and ")}` : ""}.`,
    "",
    `Closes #${input.issueNumber}`,
  ].join("\n")
}

export function adoptPullRequestBody(
  input: AdoptInput,
  result: {
    readonly changeset: string | null
    readonly promoted: AdoptResult["promoted"]
  },
): string {
  const promoted =
    "path" in result.promoted
      ? `the factory's independent check, promoted to \`${result.promoted.path}\` (translated from node:test; this PR's CI is its first run)`
      : `no promoted test: ${result.promoted.skipped} — add the regression test by hand`
  return [
    `Adopts the software factory's draft PR ${input.factoryPullRequest.url} (work order \`${input.workOrderId}\`) for #${input.issue.number}.`,
    "",
    "The first commit is the factory's, cherry-picked unchanged: the candidate a person approved as bundle",
    `\`${input.bundleDigest}\` (receipt \`${input.receiptId}\`, verifier \`${input.verifierIdentity}\`), verified in the target's image at the pin and re-verified at approval.`,
    "",
    `The second commit is the adopter's: ${result.changeset ? `a changeset (\`${result.changeset}\`) and ` : ""}${promoted}.`,
    "",
    `Closes #${input.issue.number}`,
  ].join("\n")
}

/**
 * Run the hand-off. Every git step is in a temporary worktree of the operator's checkout, so
 * the checkout's own branch and working tree are untouched; the worktree is removed whatever
 * happens, and the branch it made is left (pushed, or not yet) for the person.
 */
export async function adopt(input: AdoptInput, deps: AdoptDeps): Promise<AdoptResult> {
  const exec =
    deps.exec ??
    (async (command, args, options) => {
      const { stdout } = await execFileAsync(command, [...args], {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      })
      return { stdout }
    })
  const root = input.repositoryRoot
  const git = (args: readonly string[], cwd = root) => exec("git", args, { cwd })
  const branch = input.branch ?? adoptBranchName(input.workOrderId)
  if (!/^[\w./-]+$/.test(branch) || branch.startsWith("factory/"))
    throw new AdoptError(`Refusing branch name ${JSON.stringify(branch)}`)

  const exists = await git(["branch", "--list", branch]).then((r) => r.stdout.trim() !== "")
  if (exists)
    throw new AdoptError(`Branch ${branch} already exists in ${root}; pass --branch <name>`)

  await git(["fetch", "--quiet", "origin", input.baseBranch, input.factoryBranch])
  const scratch = await mkdtemp(join(tmpdir(), "factory-adopt-"))
  const worktree = join(scratch, "worktree")
  try {
    await git(["worktree", "add", "--quiet", "-b", branch, worktree, `origin/${input.baseBranch}`])
    await git(["cherry-pick", "--quiet", input.headSha], worktree)

    // The package, read from the branch: its name for the changeset, unless it is private.
    let changeset: { path: string; text: string } | null = null
    if (input.packageDir !== ".") {
      const manifest = JSON.parse(
        await readFile(join(worktree, input.packageDir, "package.json"), "utf8"),
      ) as { name?: unknown; private?: unknown }
      if (typeof manifest.name === "string" && manifest.private !== true)
        changeset = changesetFor({
          workOrderId: input.workOrderId,
          packageName: manifest.name,
          title: input.issue.title,
          issueNumber: input.issue.number,
        })
    }
    const promotion = promoteCheck({
      packageDir: input.packageDir,
      checkFile: input.check.file,
      source: input.check.source,
    })
    const promoted: AdoptResult["promoted"] = promotion.ok
      ? { path: promotion.path }
      : { skipped: promotion.reason }

    const written: string[] = []
    if (changeset) {
      await mkdir(join(worktree, posix.dirname(changeset.path)), { recursive: true })
      await writeFile(join(worktree, changeset.path), changeset.text, "utf8")
      written.push(changeset.path)
    }
    if (promotion.ok) {
      await mkdir(join(worktree, posix.dirname(promotion.path)), { recursive: true })
      await writeFile(join(worktree, promotion.path), promotion.source, "utf8")
      written.push(promotion.path)
    }
    if (written.length > 0) {
      await git(["add", "--", ...written], worktree)
      await git(
        [
          "commit",
          "--quiet",
          "-m",
          adoptCommitMessage({
            title: input.issue.title,
            issueNumber: input.issue.number,
            factoryPullRequest: input.factoryPullRequest.number,
            workOrderId: input.workOrderId,
            changeset: changeset?.path ?? null,
            promoted: promotion.ok ? promotion.path : null,
          }),
        ],
        worktree,
      )
    }
    const commit = (await git(["rev-parse", "HEAD"], worktree)).stdout.trim()
    await git(["push", "--quiet", "-u", "origin", branch], worktree)

    let pullRequest: { url: string } | null = null
    let closed = false
    if (input.openPullRequest) {
      const body = adoptPullRequestBody(input, { changeset: changeset?.path ?? null, promoted })
      const bodyFile = join(scratch, "body.md")
      await writeFile(bodyFile, body, "utf8")
      const { stdout } = await exec(
        deps.gh,
        [
          "pr",
          "create",
          "--repo",
          input.repository,
          "--base",
          input.baseBranch,
          "--head",
          branch,
          "--title",
          `${input.issue.title} (#${input.issue.number})`,
          "--body-file",
          bodyFile,
        ],
        { cwd: worktree },
      )
      const url = stdout.trim().split("\n").at(-1) ?? ""
      if (!/^https:\/\//.test(url))
        throw new AdoptError(`gh pr create answered without a URL: ${stdout}`)
      pullRequest = { url }
      if (input.closeFactoryPullRequest) {
        const number = String(input.factoryPullRequest.number)
        await exec(
          deps.gh,
          [
            "pr",
            "comment",
            number,
            "--repo",
            input.repository,
            "--body",
            `Adopted as ${url}: the delivered commit cherry-picked onto \`${branch}\`${changeset ? ", with a changeset" : ""}${promotion.ok ? ` and the independent check promoted to \`${promotion.path}\`` : ""}. Closing this draft; the factory never merges its own.`,
          ],
          { cwd: worktree },
        )
        await exec(deps.gh, ["pr", "close", number, "--repo", input.repository], { cwd: worktree })
        closed = true
      }
    }
    return {
      ok: true,
      branch,
      commit,
      changeset: changeset?.path ?? null,
      promoted,
      pullRequest,
      factoryPullRequest: { number: input.factoryPullRequest.number, closed },
    }
  } finally {
    await git(["worktree", "remove", "--force", worktree]).catch(() => undefined)
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}
