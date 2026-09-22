import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import { z } from "zod"
import { REPOSITORY_PATTERN } from "../domain/work-order.js"

/** Runs `file` with `args` and resolves its stdout; rejects when the process fails. */
export type Exec = (file: string, args: readonly string[]) => Promise<{ stdout: string }>

/** `gh`/`git` through execFile with a bounded time and buffer; the default Exec. */
export const execFileExec: Exec = async (file, args) => {
  const { stdout } = await promisify(execFile)(file, [...args], {
    timeout: 30_000,
    maxBuffer: 1 << 20,
    encoding: "utf8",
  })
  return { stdout }
}

/** The failure text a child process left, with its stderr when it wrote any. */
function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const stderr = (error as { stderr?: unknown }).stderr
  return typeof stderr === "string" && stderr.trim() ? `${message}\n${stderr.trim()}` : message
}

const GhIssueSchema = z.object({ title: z.string(), body: z.string(), url: z.string() })

export interface FetchedIssue {
  readonly title: string
  readonly body: string
  readonly url: string
  /** sha256 of `title\nbody`: what `origin.bodyDigest` records, so an edited issue is detectable. */
  readonly bodyDigest: string
}

/** The digest `FetchedIssue.bodyDigest` carries. */
export function issueBodyDigest(issue: { readonly title: string; readonly body: string }): string {
  return createHash("sha256").update(`${issue.title}\n${issue.body}`).digest("hex")
}

/** Reads one issue through `gh issue view --json`, the operator's own authenticated gh. */
export async function fetchIssue(input: {
  readonly repository: string
  readonly number: number
  /** The gh executable; the CLI passes `FACTORY_GH` so a test can stub it. */
  readonly gh?: string
  readonly exec?: Exec
}): Promise<FetchedIssue> {
  const { repository, number } = input
  if (!REPOSITORY_PATTERN.test(repository))
    throw new Error(`repository must be owner/name, got ${JSON.stringify(repository)}`)
  if (!Number.isInteger(number) || number <= 0)
    throw new Error(`issue number must be a positive integer, got ${String(number)}`)
  const exec = input.exec ?? execFileExec
  const ref = `${repository}#${number}`
  let stdout: string
  try {
    ;({ stdout } = await exec(input.gh ?? "gh", [
      "issue",
      "view",
      String(number),
      "--repo",
      repository,
      "--json",
      "title,body,url",
    ]))
  } catch (error) {
    throw new Error(`gh issue view failed for ${ref}: ${failureText(error)}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    throw new Error(`gh issue view output for ${ref} is not JSON: ${stdout.slice(0, 200)}`)
  }
  const parsed = GhIssueSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
    throw new Error(`gh issue view output for ${ref} is not an issue: ${issues.join("; ")}`)
  }
  const { title, body, url } = parsed.data
  return { title, body, url, bodyDigest: issueBodyDigest({ title, body }) }
}

const COMMIT_PATTERN = /^[a-f0-9]{40}$/

/**
 * The commit a new issue work order is pinned to: `origin/main` of the target checkout,
 * refreshed with a shallow fetch first so the pin is main as of now, not as of the last pull.
 */
export async function resolvePin(input: {
  readonly repositoryRoot: string
  /** Default true; false reads the checkout's own `origin/main` without touching the network. */
  readonly fetch?: boolean
  readonly exec?: Exec
}): Promise<string> {
  const exec = input.exec ?? execFileExec
  const git = ["-C", input.repositoryRoot]
  if (input.fetch !== false) {
    try {
      await exec("git", [...git, "fetch", "--depth=1", "origin", "main"])
    } catch (error) {
      throw new Error(`git fetch failed in ${input.repositoryRoot}: ${failureText(error)}`)
    }
  }
  let stdout: string
  try {
    ;({ stdout } = await exec("git", [...git, "rev-parse", "origin/main"]))
  } catch (error) {
    throw new Error(
      `git rev-parse origin/main failed in ${input.repositoryRoot}: ${failureText(error)}`,
    )
  }
  const sha = stdout.trim()
  if (!COMMIT_PATTERN.test(sha))
    throw new Error(
      `origin/main in ${input.repositoryRoot} is not a commit: ${JSON.stringify(sha)}`,
    )
  return sha
}

/**
 * The `issue.md` a work order keeps: the title, the reference and the body, with the body's
 * trailing newlines normalised to one so the same issue always renders the same bytes.
 */
export function issueText(input: {
  readonly title: string
  readonly body: string
  readonly repository: string
  readonly number: number
}): string {
  return `# ${input.title} (${input.repository}#${input.number})\n\n${input.body.replace(/\n*$/, "")}\n`
}

/** `owner/name` from a GitHub remote url in its ssh, ssh-scheme or https form; null otherwise. */
export function repositoryFromRemoteUrl(url: string): string | null {
  const match = url
    .trim()
    .match(
      /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/,
    )
  return match?.[1] ?? null
}
