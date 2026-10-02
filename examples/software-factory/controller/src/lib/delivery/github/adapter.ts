import type { KeyObject } from "node:crypto"
import {
  type Comparison,
  type DeliveryAdapter,
  DeliveryError,
  type DeliverySession,
  type RemoteCommit,
  type RemotePull,
} from "../adapter.js"
import type { GitTreeEntry } from "../git-objects.js"
import { type Auth, CLOSING_ISSUES_QUERY, githubRequest, type RequestOptions } from "./http.js"
import { appJwt } from "./jwt.js"

/**
 * The real `DeliveryAdapter` (rung 4 spec §6): GitHub's REST and GraphQL APIs under an
 * installation token minted per worker run, downscoped to the one repository and to exactly
 * the permissions delivery needs. The token lives in this object's memory for the run and
 * nowhere else: not the registry, the journal, a log, a file, argv or a child's environment.
 */

/** What delivery needs, and all a minted token may carry (spec §2 D2, §15 item 2). */
export const DELIVERY_PERMISSIONS: Readonly<Record<string, "read" | "write">> = Object.freeze({
  contents: "write",
  pull_requests: "write",
  metadata: "read",
  issues: "read",
})

export interface GitHubAdapterOptions {
  /** The one repository this adapter delivers to (D27); `open` refuses any other. */
  readonly repository: string
  readonly appId: number
  readonly privateKey: KeyObject
  readonly baseBranch: string
  readonly fetch?: typeof fetch
  readonly baseUrl?: string
  readonly now?: () => number
  /** One request's bound (D25). Default 30 s. */
  readonly requestTimeoutMs?: number
}

const asRecord = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null)
    throw new DeliveryError("unexpected", `${what}: the response is not an object`)
  return value as Record<string, unknown>
}
const asString = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw new DeliveryError("unexpected", `${what} is not a string`)
  return value
}

function pullOf(value: unknown): RemotePull {
  const pull = asRecord(value, "pull request")
  const head = asRecord(pull.head, "pull request head")
  const base = asRecord(pull.base, "pull request base")
  const user = asRecord(pull.user, "pull request user")
  const repo = head.repo === null ? null : asRecord(head.repo, "pull request head repository")
  return {
    number: Number(pull.number),
    url: asString(pull.html_url, "html_url"),
    nodeId: asString(pull.node_id, "node_id"),
    state: pull.state === "open" ? "open" : "closed",
    draft: pull.draft === true,
    merged: pull.merged === true || (typeof pull.merged_at === "string" && pull.merged_at !== ""),
    author: asString(user.login, "user.login"),
    headRef: asString(head.ref, "head.ref"),
    headRepository: repo === null ? null : asString(repo.full_name, "head.repo.full_name"),
    headSha: asString(head.sha, "head.sha"),
    baseRef: asString(base.ref, "base.ref"),
  }
}

export function createGitHubAdapter(options: GitHubAdapterOptions): DeliveryAdapter {
  const doFetch = options.fetch ?? fetch
  const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "")
  const now = options.now ?? Date.now
  /** Every token minted, for the scrubber; each session uses only its own. */
  const minted = new Set<string>()

  return {
    secrets: () => [...minted],
    async open(repository, signal) {
      if (repository !== options.repository)
        throw new DeliveryError(
          "unauthorized",
          `this controller delivers to ${options.repository}, not ${repository}`,
        )
      let token: string | undefined
      const [owner, name] = repository.split("/") as [string, string]
      const target = { repository, baseBranch: options.baseBranch }
      const request: RequestOptions = {
        fetch: doFetch,
        baseUrl,
        target,
        signal,
        now,
        timeoutMs: options.requestTimeoutMs ?? 30_000,
        credential: (auth: Auth) => {
          if (auth === "jwt") return appJwt(options.appId, options.privateKey, now())
          if (token === undefined) throw new DeliveryError("unauthorized", "no installation token")
          return token
        },
      }
      const get = async (path: string) => (await githubRequest(request, "GET", path)).json
      const post = async (path: string, body: unknown) =>
        (await githubRequest(request, "POST", path, body)).json
      const repo = `/repos/${repository}`

      // Who the app is, where it is installed, and a token for exactly this repository and
      // exactly these permissions: GitHub refuses to mint wider than the installation, so the
      // mint is also the check that the installation still grants them.
      const app = asRecord(await get("/app"), "app")
      const botLogin = `${asString(app.slug, "app.slug")}[bot]`
      let installation: Record<string, unknown>
      try {
        installation = asRecord(await get(`${repo}/installation`), "installation")
      } catch (error) {
        if (error instanceof DeliveryError && error.kind === "not_found")
          throw new DeliveryError("unauthorized", `the app is not installed on ${repository}`)
        throw error
      }
      let mint: Record<string, unknown>
      try {
        mint = asRecord(
          await post(`/app/installations/${Number(installation.id)}/access_tokens`, {
            repositories: [name],
            permissions: DELIVERY_PERMISSIONS,
          }),
          "access token",
        )
      } catch (error) {
        if (
          error instanceof DeliveryError &&
          (error.kind === "conflict" || error.kind === "not_found")
        )
          throw new DeliveryError(
            "unauthorized",
            `the installation refused the token: ${error.message}`,
          )
        throw error
      }
      token = asString(mint.token, "token")
      minted.add(token)
      const granted = asRecord(mint.permissions ?? {}, "granted permissions")
      const missing = Object.entries(DELIVERY_PERMISSIONS).filter(
        ([scope, level]) =>
          !(granted[scope] === level || (level === "read" && granted[scope] === "write")),
      )
      if (missing.length > 0)
        throw new DeliveryError(
          "unauthorized",
          `the installation grants too little: ${missing.map(([s, l]) => `${s}: ${l}`).join(", ")}`,
        )
      await get(repo)
      const bot = asRecord(await get(`/users/${encodeURIComponent(botLogin)}`), "bot user")
      const identity = {
        name: botLogin,
        email: `${Number(bot.id)}+${botLogin}@users.noreply.github.com`,
      }

      const session: DeliverySession = {
        botLogin,
        identity,
        async branchRules(branch) {
          const rules = await get(`${repo}/rules/branches/${branch}`)
          return Array.isArray(rules) ? rules.map((r) => String(asRecord(r, "rule").type)) : []
        },
        async issueState(number) {
          const issue = asRecord(await get(`${repo}/issues/${number}`), "issue")
          return issue.state === "closed" ? "closed" : "open"
        },
        async branchHead(branch) {
          try {
            const ref = asRecord(await get(`${repo}/git/ref/heads/${branch}`), "ref")
            return asString(asRecord(ref.object, "ref.object").sha, "ref sha")
          } catch (error) {
            if (error instanceof DeliveryError && error.kind === "not_found") return null
            throw error
          }
        },
        async compare(base, head): Promise<Comparison> {
          const c = asRecord(await get(`${repo}/compare/${base}...${head}`), "comparison")
          const files = Array.isArray(c.files) ? c.files.map((f) => asRecord(f, "file")) : []
          return {
            status:
              (["ahead", "behind", "diverged", "identical"] as const).find((s) => s === c.status) ??
              "diverged",
            aheadBy: Number(c.ahead_by ?? 0),
            files: files.map((f) => ({
              filename: asString(f.filename, "filename"),
              ...(typeof f.previous_filename === "string"
                ? { previousFilename: f.previous_filename }
                : {}),
            })),
            // GitHub lists at most 300 files per comparison and says nothing when it stops.
            complete: files.length < 300,
          }
        },
        async commit(sha): Promise<RemoteCommit> {
          const c = asRecord(await get(`${repo}/git/commits/${sha}`), "commit")
          return {
            sha: asString(c.sha, "commit sha"),
            tree: asString(asRecord(c.tree, "commit tree").sha, "tree sha"),
            parents: Array.isArray(c.parents)
              ? c.parents.map((p) => asString(asRecord(p, "parent").sha, "parent sha"))
              : [],
          }
        },
        async tree(sha): Promise<GitTreeEntry[]> {
          const t = asRecord(await get(`${repo}/git/trees/${sha}`), "tree")
          if (t.truncated === true)
            throw new DeliveryError("unexpected", `tree ${sha} was truncated`)
          return (Array.isArray(t.tree) ? t.tree : []).map((e) => {
            const entry = asRecord(e, "tree entry")
            return {
              name: asString(entry.path, "entry path"),
              mode: asString(entry.mode, "entry mode"),
              type: asString(entry.type, "entry type") as GitTreeEntry["type"],
              sha: asString(entry.sha, "entry sha"),
            }
          })
        },
        async createBlob(text) {
          const blob = asRecord(
            await post(`${repo}/git/blobs`, {
              content: Buffer.from(text, "utf8").toString("base64"),
              encoding: "base64",
            }),
            "blob",
          )
          return asString(blob.sha, "blob sha")
        },
        async createTree(baseTree, entries) {
          const tree = asRecord(
            await post(`${repo}/git/trees`, {
              base_tree: baseTree,
              tree: entries.map((e) => ({ path: e.path, mode: e.mode, type: "blob", sha: e.sha })),
            }),
            "tree",
          )
          return asString(tree.sha, "tree sha")
        },
        async createCommit(input) {
          const commit = asRecord(
            await post(`${repo}/git/commits`, {
              message: input.message,
              tree: input.tree,
              parents: input.parents,
              author: input.author,
              committer: input.committer,
            }),
            "commit",
          )
          return asString(commit.sha, "commit sha")
        },
        async createBranch(branch, sha) {
          try {
            await post(`${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha })
            return "created"
          } catch (error) {
            if (
              error instanceof DeliveryError &&
              error.status === 422 &&
              /already exists/i.test(error.message)
            )
              return "exists"
            throw error
          }
        },
        async pullsByHead(branch) {
          const pulls = await get(
            `${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=100`,
          )
          return Array.isArray(pulls) ? pulls.map(pullOf) : []
        },
        async createDraftPull(input) {
          try {
            return pullOf(
              await post(`${repo}/pulls`, {
                title: input.title,
                body: input.body,
                head: input.head,
                base: input.base,
                draft: true,
                maintainer_can_modify: false,
              }),
            )
          } catch (error) {
            if (
              error instanceof DeliveryError &&
              error.status === 422 &&
              /pull request already exists/i.test(error.message)
            )
              return "exists"
            throw error
          }
        },
        async pull(number) {
          return pullOf(await get(`${repo}/pulls/${number}`))
        },
        async closingIssues(number) {
          const answer = asRecord(
            await post("/graphql", {
              query: CLOSING_ISSUES_QUERY,
              variables: { owner, name, number },
            }),
            "graphql",
          )
          if (Array.isArray(answer.errors) && answer.errors.length > 0)
            throw new DeliveryError("unexpected", "the closing-issues query answered errors")
          const nodes = (
            (
              (answer.data as Record<string, unknown> | undefined)?.repository as
                | Record<string, unknown>
                | undefined
            )?.pullRequest as Record<string, unknown> | undefined
          )?.closingIssuesReferences as { nodes?: { number: number }[] } | undefined
          return (nodes?.nodes ?? []).map((n) => Number(n.number))
        },
      }
      return session
    },
  }
}
