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
import { FACTORY_BOT_LOGIN } from "../guard.js"
import {
  type Auth,
  CLOSING_ISSUES_QUERY,
  DELIVERY_PERMISSIONS,
  githubRequest,
  type RequestOptions,
} from "./http.js"
import { appJwt } from "./jwt.js"

/**
 * The real `DeliveryAdapter` (rung 4 spec §6): GitHub's REST and GraphQL APIs under an
 * installation token minted per worker run, downscoped to the one repository and to exactly
 * the permissions delivery needs. The token lives in this object's memory for the run and
 * nowhere else: not the registry, the journal, a log, a file, argv or a child's environment.
 */

/** Defined beside the allow-list, which holds the mint to exactly these. */
export { DELIVERY_PERMISSIONS }

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
const asId = (value: unknown, what: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new DeliveryError("unexpected", `${what} is not a positive integer`)
  return value
}

/** A token is not used within this long of its expiry: the next request mints a fresh one. */
const TOKEN_MARGIN_MS = 5 * 60_000

function pullOf(value: unknown): RemotePull {
  const pull = asRecord(value, "pull request")
  const head = asRecord(pull.head, "pull request head")
  const base = asRecord(pull.base, "pull request base")
  const user = asRecord(pull.user, "pull request user")
  const repo = head.repo === null ? null : asRecord(head.repo, "pull request head repository")
  return {
    number: asId(pull.number, "the pull request number"),
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
      let token: { readonly value: string; readonly expiresAt: number } | undefined
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
          return token.value
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
      // The CI guard skips only the factory's bot, and the worker confirms only its pull
      // requests: a key for another app would open pull requests the factory never calls ours.
      if (botLogin !== FACTORY_BOT_LOGIN)
        throw new DeliveryError(
          "unauthorized",
          `the configured app is ${botLogin}, not ${FACTORY_BOT_LOGIN}; configure the factory's own app`,
        )
      let installation: Record<string, unknown>
      try {
        installation = asRecord(await get(`${repo}/installation`), "installation")
      } catch (error) {
        if (error instanceof DeliveryError && error.kind === "not_found")
          throw new DeliveryError("unauthorized", `the app is not installed on ${repository}`)
        throw error
      }
      const installationId = asId(installation.id, "the installation id")

      /** A token for exactly this repository and these permissions, replacing the last. */
      const mintToken = async () => {
        let mint: Record<string, unknown>
        try {
          mint = asRecord(
            await post(`/app/installations/${installationId}/access_tokens`, {
              repositories: [name],
              permissions: DELIVERY_PERMISSIONS,
            }),
            "access token",
          )
        } catch (error) {
          // 422: wider than the installation grants; 404: the installation is gone.
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
        const value = asString(mint.token, "token")
        // Scrubbed from here on, whatever is wrong with the rest of the answer.
        minted.add(value)
        const expiresAt =
          typeof mint.expires_at === "string" ? Date.parse(mint.expires_at) : Number.NaN
        if (Number.isNaN(expiresAt))
          throw new DeliveryError("unexpected", "the minted token's expires_at is not a time")
        if (expiresAt - TOKEN_MARGIN_MS <= now())
          throw new DeliveryError(
            "unexpected",
            `the minted token expires_at ${String(mint.expires_at)}, within ${TOKEN_MARGIN_MS / 60_000} minutes (is the clock wrong?)`,
          )
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
        token = { value, expiresAt }
      }
      await mintToken()
      // Under the token, a fresh one first when this one is near its expiry: a run may outlast it.
      const fresh = async () => {
        if (token === undefined || now() >= token.expiresAt - TOKEN_MARGIN_MS) await mintToken()
      }
      const read = async (path: string) => {
        await fresh()
        return get(path)
      }
      const write = async (path: string, body: unknown) => {
        await fresh()
        return post(path, body)
      }

      // GitHub answers a repository by any case of its name, and its pull requests' heads by
      // the canonical one, which the worker compares exactly: the configured name must be it.
      const named = asString(asRecord(await read(repo), "repository").full_name, "full_name")
      if (named !== repository)
        throw new DeliveryError(
          "unauthorized",
          named.toLowerCase() === repository.toLowerCase()
            ? `GitHub names the repository ${named}; configure the delivery repository exactly so, not ${repository}`
            : `GitHub answers ${repository} as ${named}; configure the delivery repository by its current name`,
        )
      const bot = asRecord(await read(`/users/${encodeURIComponent(botLogin)}`), "bot user")
      const identity = {
        name: botLogin,
        email: `${asId(bot.id, "the bot user's id")}+${botLogin}@users.noreply.github.com`,
      }

      const session: DeliverySession = {
        botLogin,
        identity,
        async branchRules(branch) {
          const rules = await read(`${repo}/rules/branches/${branch}`)
          return Array.isArray(rules) ? rules.map((r) => String(asRecord(r, "rule").type)) : []
        },
        async issueState(number) {
          let answer: unknown
          try {
            answer = await read(`${repo}/issues/${number}`)
          } catch (error) {
            // Transferred (301, whose target is never asked) or deleted (410): the issue the
            // work order names is not an open issue of this repository any more.
            if (error instanceof DeliveryError && (error.status === 301 || error.status === 410))
              return "gone"
            throw error
          }
          const issue = asRecord(answer, "issue")
          return issue.state === "closed" ? "closed" : "open"
        },
        async branchHead(branch) {
          try {
            const ref = asRecord(await read(`${repo}/git/ref/heads/${branch}`), "ref")
            return asString(asRecord(ref.object, "ref.object").sha, "ref sha")
          } catch (error) {
            if (error instanceof DeliveryError && error.kind === "not_found") return null
            throw error
          }
        },
        async compare(base, head): Promise<Comparison> {
          const c = asRecord(await read(`${repo}/compare/${base}...${head}`), "comparison")
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
          const c = asRecord(await read(`${repo}/git/commits/${sha}`), "commit")
          return {
            sha: asString(c.sha, "commit sha"),
            tree: asString(asRecord(c.tree, "commit tree").sha, "tree sha"),
            parents: Array.isArray(c.parents)
              ? c.parents.map((p) => asString(asRecord(p, "parent").sha, "parent sha"))
              : [],
          }
        },
        async tree(sha): Promise<GitTreeEntry[]> {
          const t = asRecord(await read(`${repo}/git/trees/${sha}`), "tree")
          if (t.truncated === true)
            throw new DeliveryError("incomplete", `tree ${sha} was truncated`)
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
            await write(`${repo}/git/blobs`, {
              content: Buffer.from(text, "utf8").toString("base64"),
              encoding: "base64",
            }),
            "blob",
          )
          return asString(blob.sha, "blob sha")
        },
        async createTree(baseTree, entries) {
          const tree = asRecord(
            await write(`${repo}/git/trees`, {
              base_tree: baseTree,
              tree: entries.map((e) => ({ path: e.path, mode: e.mode, type: "blob", sha: e.sha })),
            }),
            "tree",
          )
          return asString(tree.sha, "tree sha")
        },
        async createCommit(input) {
          const commit = asRecord(
            await write(`${repo}/git/commits`, {
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
            await write(`${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha })
            return "created"
          } catch (error) {
            if (
              error instanceof DeliveryError &&
              error.status === 422 &&
              /reference already exists/i.test(error.message)
            )
              return "exists"
            throw error
          }
        },
        async pullsByHead(branch) {
          const pulls = await read(
            `${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=100`,
          )
          return Array.isArray(pulls) ? pulls.map(pullOf) : []
        },
        async createDraftPull(input) {
          try {
            return pullOf(
              await write(`${repo}/pulls`, {
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
              // GitHub says so in errors[]: 422 "Validation Failed: A pull request already exists for …"
              /a pull request already exists for /i.test(error.message)
            )
              return "exists"
            throw error
          }
        },
        async pull(number) {
          return pullOf(await read(`${repo}/pulls/${number}`))
        },
        async closingIssues(number) {
          const answer = asRecord(
            await write("/graphql", {
              query: CLOSING_ISSUES_QUERY,
              variables: { owner, name, number },
            }),
            "graphql",
          )
          if (Array.isArray(answer.errors) && answer.errors.length > 0)
            throw new DeliveryError("unexpected", "the closing-issues query answered errors")
          const data = answer.data as Record<string, unknown> | null | undefined
          const found = (data?.repository as Record<string, unknown> | null | undefined)
            ?.pullRequest as Record<string, unknown> | null | undefined
          // Nothing to read is not "closes nothing": the answer is refused, never read as empty.
          if (found === null || found === undefined)
            throw new DeliveryError(
              "unexpected",
              `the closing-issues query found no pull request #${number}`,
            )
          const references = asRecord(found.closingIssuesReferences, "closingIssuesReferences")
          if (!Array.isArray(references.nodes))
            throw new DeliveryError("unexpected", "closingIssuesReferences.nodes is not a list")
          return references.nodes.map((n) =>
            asId(asRecord(n, "closing issue").number, "an issue number"),
          )
        },
      }
      return session
    },
  }
}
