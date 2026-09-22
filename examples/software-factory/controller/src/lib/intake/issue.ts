import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import { z } from "zod"
import { COMMIT_PATTERN, REPOSITORY_PATTERN } from "../domain/work-order.js"

/** Runs `file` with `args` and resolves its stdout; rejects when the process fails. */
export type Exec = (file: string, args: readonly string[]) => Promise<{ stdout: string }>

const TIMEOUT_MS = 30_000
const MAX_BUFFER = 1 << 20

/** `gh`/`git` through execFile with a bounded time and buffer; the default Exec. */
export const execFileExec: Exec = async (file, args) => {
  const { stdout } = await promisify(execFile)(file, [...args], {
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    encoding: "utf8",
  })
  return { stdout }
}

/**
 * What a failed child process should be reported as. Built from the error's fields rather than
 * its message: execFile's message already embeds stderr (so appending it would repeat it), and
 * a timeout only shows as `killed` with no word about why.
 */
export function failureText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const { killed, signal, code, stderr } = error as Error & {
    killed?: boolean
    signal?: string | null
    code?: number | string | null
    stderr?: unknown
  }
  const detail = typeof stderr === "string" && stderr.trim() ? `: ${stderr.trim()}` : ""
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    return `output exceeded ${MAX_BUFFER >> 10} KiB${detail}`
  if (killed) return `timed out after ${TIMEOUT_MS / 1000}s${signal ? ` (${signal})` : ""}${detail}`
  if (typeof code === "number") return `exited ${code}${detail}`
  if (signal) return `killed by ${signal}${detail}`
  return detail ? detail.slice(2) : error.message
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

/**
 * The commit a new issue work order is pinned to: `origin/<branch>` of the target checkout,
 * fetched first so the pin is the branch as of now, not as of the last pull. The fetch is a
 * plain one: `--depth=1` would turn the operator's full clone into a shallow one (`.git/shallow`,
 * truncated history, shared by every linked worktree), and a plain fetch of an existing clone
 * is already incremental.
 */
export async function resolvePin(input: {
  readonly repositoryRoot: string
  /** The branch to pin; default `main`. */
  readonly branch?: string
  /** Default true; false reads the checkout's own `origin/<branch>` without touching the network. */
  readonly fetch?: boolean
  readonly exec?: Exec
}): Promise<string> {
  const exec = input.exec ?? execFileExec
  const branch = input.branch ?? "main"
  const ref = `origin/${branch}`
  const git = ["-C", input.repositoryRoot]
  if (input.fetch !== false) {
    try {
      await exec("git", [...git, "fetch", "origin", branch])
    } catch (error) {
      throw new Error(`git fetch failed in ${input.repositoryRoot}: ${failureText(error)}`)
    }
  }
  let stdout: string
  try {
    ;({ stdout } = await exec("git", [...git, "rev-parse", ref]))
  } catch (error) {
    throw new Error(`git rev-parse ${ref} failed in ${input.repositoryRoot}: ${failureText(error)}`)
  }
  const sha = stdout.trim()
  if (!COMMIT_PATTERN.test(sha))
    throw new Error(`${ref} in ${input.repositoryRoot} is not a commit: ${JSON.stringify(sha)}`)
  return sha
}

/**
 * The `issue.md` a work order keeps: the title, the reference and the body. Line endings are
 * normalised to LF (a web-authored GitHub body is CRLF) and trailing newlines to one, so the
 * same issue always renders the same bytes; an empty body renders as the heading and one blank
 * line. `bodyDigest` stays over the raw body, so this normalisation never hides an edit.
 */
export function issueText(input: {
  readonly title: string
  readonly body: string
  readonly repository: string
  readonly number: number
}): string {
  const heading = `# ${input.title} (${input.repository}#${input.number})\n`
  const body = input.body.replace(/\r\n?/g, "\n").replace(/\n*$/, "")
  return body ? `${heading}\n${body}\n` : heading
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
