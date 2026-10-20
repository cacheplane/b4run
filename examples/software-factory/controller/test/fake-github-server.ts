import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { DeliverySession } from "../src/lib/delivery/adapter.ts"
import { BOT, createFakeGitHub, type FakeGitHub, REPOSITORY } from "./fake-delivery-adapter.ts"

/**
 * GitHub's REST and GraphQL endpoints as the real adapter calls them, on loopback, backed by
 * the in-memory repository of `fake-delivery-adapter.ts`. It answers in GitHub's real shapes
 * and status codes, as GitHub documents and sends them:
 *
 * - 201 on create, with the created object;
 * - a ref that exists: 422 `{ message: "Reference already exists" }`;
 * - a pull request that exists: 422 `{ message: "Validation Failed", errors: [{ resource:
 *   "PullRequest", code: "custom", message: "A pull request already exists for <owner>:<branch>." }] }`,
 *   the text only in `errors[]`;
 * - 404 `{ message: "Not Found" }` for a missing ref, commit or pull request, and 401
 *   `{ message: "Bad credentials" }` for a token it never minted;
 * - the pulls listing's `head` filter as GitHub applies it: `<owner>:<branch>`, nothing for
 *   another owner, and every pull request when the owner is left off (GitHub ignores it);
 * - GraphQL's `pullRequest: null` plus `errors` for a number that names no pull request.
 *
 * Every object carries at least the top-level keys GitHub sends for it (the scratch lane's
 * recording in `fixtures/github-contract.json`, replayed by `github-contract.test.ts`), with
 * placeholder values of GitHub's types: ids of 1, zero hashes, `example.invalid` web URLs.
 *
 * Each mint is a distinct token that expires an hour after the server's clock, and a request
 * under a token is honoured only when that token was minted. It can be told to answer any
 * request with a scripted status and headers instead. Every request is logged with its method,
 * path, authorization scheme, which minted token it carried (by index, never the value), its
 * body and the status it was answered with.
 */

export interface ScriptedAnswer {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: unknown
  /** Perform the request first, then answer this: a response lost after the write. */
  readonly after?: boolean
  /** Hold the answer this long: a request past the adapter's per-request bound. */
  readonly delayMs?: number
}

export interface LoggedRequest {
  readonly method: string
  readonly path: string
  readonly auth: string
  /** Which minted token the request carried, by mint order; -1 for none or an unknown one. */
  readonly token: number
  readonly body: unknown
  status: number
}

export interface FakeGitHubServer {
  readonly url: string
  readonly repo: FakeGitHub
  readonly requests: LoggedRequest[]
  /** Every installation token minted, in order. */
  readonly tokens: readonly string[]
  /** Permissions the mint grants; the delivery set by default. */
  granted: Record<string, string>
  installed: boolean
  /** The app's slug, as `GET /app` answers it. */
  slug: string
  /** The installation id `GET /repos/{repo}/installation` answers. */
  installationId: unknown
  /** The server's clock, for a token's `expires_at`. */
  now: () => number
  /** Rewrites every pull request object it answers: a fork's head, another author. */
  pullShape: ((pull: Record<string, unknown>) => Record<string, unknown>) | undefined
  answer(method: string, path: RegExp, answer: ScriptedAnswer, times?: number): void
  close(): Promise<void>
}

const DOCS = "https://docs.github.com/rest"
const notFound = { message: "Not Found", documentation_url: DOCS, status: "404" }
const API = "https://api.github.com"
/** The web host the fake's `html_url`s point at: never a real one. */
const WEB = "https://github.example.invalid"
const T0 = "2026-01-01T00:00:00Z"
const ZERO_SHA = "0".repeat(40)

/** A user or bot as GitHub nests it (`owner`, `user`, `account`): GitHub's keys, no values of note. */
function userJson(login: string, id: number, type: "User" | "Bot" | "Organization") {
  const url = `${API}/users/${encodeURIComponent(login)}`
  return {
    login,
    id,
    node_id: `U_${id}`,
    avatar_url: `${WEB}/avatars/u/${id}`,
    gravatar_id: "",
    url,
    html_url: `${WEB}/${login}`,
    followers_url: `${url}/followers`,
    following_url: `${url}/following{/other_user}`,
    gists_url: `${url}/gists{/gist_id}`,
    starred_url: `${url}/starred{/owner}{/repo}`,
    subscriptions_url: `${url}/subscriptions`,
    organizations_url: `${url}/orgs`,
    repos_url: `${url}/repos`,
    events_url: `${url}/events{/privacy}`,
    received_events_url: `${url}/received_events`,
    type,
    site_admin: false,
    user_view_type: "public",
  }
}

/** A git identity as GitHub answers it on a commit's `author` and `committer`. */
const identity = { name: "fake", email: "fake@example.invalid", date: T0 }

/** The `verification` block of an unsigned commit. */
const unverified = {
  verified: false,
  reason: "unsigned",
  signature: null,
  payload: null,
  verified_at: null,
}

/** The commit summary GitHub nests in a comparison's `base_commit`, `merge_base_commit` and `commits`. */
function commitSummary(repository: string, sha: string) {
  return {
    sha,
    node_id: `C_${sha}`,
    url: `${API}/repos/${repository}/commits/${sha}`,
    html_url: `${WEB}/${repository}/commit/${sha}`,
    comments_url: `${API}/repos/${repository}/commits/${sha}/comments`,
    commit: {
      message: "m",
      tree: { sha: ZERO_SHA, url: "" },
      author: identity,
      committer: identity,
    },
    author: null,
    committer: null,
    parents: [],
  }
}

export async function startFakeGitHubServer(): Promise<FakeGitHubServer> {
  const repo = createFakeGitHub()
  const session = await repo.open(REPOSITORY, new AbortController().signal)
  const scripted: { method: string; path: RegExp; answer: ScriptedAnswer; remaining: number }[] = []
  const requests: LoggedRequest[] = []
  const tokens: string[] = []
  const [OWNER] = REPOSITORY.split("/") as [string, string]
  const prefix = `/repos/${REPOSITORY}`

  const [, REPO] = REPOSITORY.split("/") as [string, string]

  /** The repository as `GET /repos/{owner}/{repo}` answers it. */
  const repoJson = () => {
    const url = `${API}${prefix}`
    const urls = Object.fromEntries(
      [
        "archive",
        "assignees",
        "blobs",
        "branches",
        "collaborators",
        "comments",
        "commits",
        "compare",
        "contents",
        "contributors",
        "deployments",
        "downloads",
        "events",
        "forks",
        "git_commits",
        "git_refs",
        "git_tags",
        "hooks",
        "issue_comment",
        "issue_events",
        "issues",
        "keys",
        "labels",
        "languages",
        "merges",
        "milestones",
        "notifications",
        "pulls",
        "releases",
        "stargazers",
        "statuses",
        "subscribers",
        "subscription",
        "tags",
        "teams",
        "trees",
      ].map((name) => [`${name}_url`, `${url}/${name.replace("_", "/")}`]),
    )
    return {
      id: 1,
      node_id: "R_1",
      name: REPO,
      full_name: REPOSITORY,
      private: false,
      owner: userJson(OWNER, 1, "Organization"),
      html_url: `${WEB}/${REPOSITORY}`,
      description: null,
      fork: false,
      url,
      ...urls,
      git_url: `git://github.example.invalid/${REPOSITORY}.git`,
      ssh_url: `git@github.example.invalid:${REPOSITORY}.git`,
      clone_url: `${WEB}/${REPOSITORY}.git`,
      svn_url: `${WEB}/${REPOSITORY}`,
      mirror_url: null,
      homepage: null,
      language: null,
      forks_count: 0,
      forks: 0,
      stargazers_count: 0,
      watchers_count: 0,
      watchers: 0,
      network_count: 0,
      subscribers_count: 0,
      size: 0,
      default_branch: "main",
      open_issues_count: 0,
      open_issues: 0,
      is_template: false,
      topics: [],
      has_issues: true,
      has_projects: false,
      has_wiki: false,
      has_pages: false,
      has_downloads: false,
      has_discussions: false,
      has_pull_requests: true,
      archived: false,
      disabled: false,
      visibility: "public",
      pushed_at: T0,
      created_at: T0,
      updated_at: T0,
      permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
      allow_rebase_merge: true,
      allow_squash_merge: true,
      allow_merge_commit: true,
      allow_auto_merge: false,
      allow_update_branch: false,
      allow_forking: true,
      delete_branch_on_merge: false,
      use_squash_pr_title_as_default: false,
      squash_merge_commit_title: "COMMIT_OR_PR_TITLE",
      squash_merge_commit_message: server.repo.mergeMessages.squash,
      merge_commit_title: "MERGE_MESSAGE",
      merge_commit_message: server.repo.mergeMessages.merge,
      pull_request_creation_policy: "anyone",
      web_commit_signoff_required: false,
      temp_clone_token: null,
      license: null,
      organization: userJson(OWNER, 1, "Organization"),
      custom_properties: {},
    }
  }

  const pullJson = (p: Awaited<ReturnType<DeliverySession["pull"]>>, single: boolean) => {
    const url = `${API}${prefix}/pulls/${p.number}`
    const issueUrl = `${API}${prefix}/issues/${p.number}`
    const json: Record<string, unknown> = {
      url,
      id: 9_000_000 + p.number,
      node_id: p.nodeId,
      html_url: p.url,
      diff_url: `${p.url}.diff`,
      patch_url: `${p.url}.patch`,
      issue_url: issueUrl,
      commits_url: `${url}/commits`,
      review_comments_url: `${url}/comments`,
      review_comment_url: `${API}${prefix}/pulls/comments{/number}`,
      comments_url: `${issueUrl}/comments`,
      statuses_url: `${API}${prefix}/statuses/${p.headSha}`,
      number: p.number,
      state: p.state,
      locked: false,
      title: "t",
      user: userJson(p.author, 123, p.author.endsWith("[bot]") ? "Bot" : "User"),
      body: "",
      labels: [],
      milestone: null,
      active_lock_reason: null,
      created_at: T0,
      updated_at: T0,
      closed_at: p.state === "closed" ? "2026-10-01T00:00:00Z" : null,
      merged_at: p.merged ? "2026-10-01T00:00:00Z" : null,
      merge_commit_sha: null,
      assignee: null,
      assignees: [],
      requested_reviewers: [],
      requested_teams: [],
      head: {
        label: `${OWNER}:${p.headRef}`,
        ref: p.headRef,
        sha: p.headSha,
        repo:
          p.headRepository === null
            ? null
            : { full_name: p.headRepository, name: p.headRepository.split("/")[1] },
      },
      base: { label: `${OWNER}:${p.baseRef}`, ref: p.baseRef, repo: { full_name: REPOSITORY } },
      _links: {
        self: { href: url },
        html: { href: p.url },
        issue: { href: issueUrl },
        comments: { href: `${issueUrl}/comments` },
        review_comments: { href: `${url}/comments` },
        review_comment: { href: `${API}${prefix}/pulls/comments{/number}` },
        commits: { href: `${url}/commits` },
        statuses: { href: `${API}${prefix}/statuses/${p.headSha}` },
      },
      author_association: "CONTRIBUTOR",
      auto_merge: null,
      draft: p.draft,
      // Only the single pull request carries `merged`, the mergeability and the counts; a
      // listing has `merged_at` alone.
      ...(single
        ? {
            merged: p.merged,
            mergeable: null,
            rebaseable: null,
            mergeable_state: "unknown",
            merged_by: null,
            comments: 0,
            review_comments: 0,
            maintainer_can_modify: false,
            commits: 1,
            additions: 0,
            deletions: 0,
            changed_files: 0,
          }
        : {}),
    }
    return server.pullShape ? server.pullShape(json) : json
  }

  async function route(method: string, url: URL, body: Record<string, unknown>) {
    const path = url.pathname
    const json = (status: number, value: unknown) => ({ status, value })
    if (method === "GET" && path === "/app")
      return json(200, {
        id: 123456,
        slug: server.slug,
        node_id: "A_1",
        client_id: "Iv1.0000000000000000",
        owner: userJson(OWNER, 1, "Organization"),
        name: server.slug,
        description: "",
        external_url: `${WEB}/apps/${server.slug}`,
        html_url: `${WEB}/apps/${server.slug}`,
        created_at: T0,
        updated_at: T0,
        permissions: server.granted,
        events: ["pull_request"],
        installations_count: 1,
      })
    if (method === "GET" && path === `${prefix}/installation`)
      return server.installed
        ? json(200, {
            id: server.installationId,
            client_id: "Iv1.0000000000000000",
            account: userJson(OWNER, 1, "Organization"),
            repository_selection: "selected",
            access_tokens_url: `${API}/app/installations/${String(server.installationId)}/access_tokens`,
            repositories_url: `${API}/installation/repositories`,
            html_url: `${WEB}/organizations/${OWNER}/settings/installations/${String(server.installationId)}`,
            app_id: 123456,
            app_slug: server.slug,
            target_id: 1,
            target_type: "Organization",
            permissions: server.granted,
            events: ["pull_request"],
            created_at: T0,
            updated_at: T0,
            single_file_name: null,
            has_multiple_single_files: false,
            single_file_paths: [],
            suspended_by: null,
            suspended_at: null,
          })
        : json(404, notFound)
    if (
      method === "POST" &&
      path === `/app/installations/${String(server.installationId)}/access_tokens`
    ) {
      const token = `ghs_fakeinstallationtoken${String(tokens.length + 1).padStart(10, "0")}`
      tokens.push(token)
      return json(201, {
        token,
        expires_at: new Date(server.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        permissions: server.granted,
        repository_selection: "selected",
        repositories: [repoJson()],
      })
    }
    if (method === "GET" && path === `/users/${encodeURIComponent(BOT)}`)
      return json(200, {
        ...userJson(BOT, 123, "Bot"),
        name: BOT,
        company: null,
        blog: "",
        location: null,
        email: null,
        hireable: null,
        bio: null,
        twitter_username: null,
        public_repos: 0,
        public_gists: 0,
        followers: 0,
        following: 0,
        created_at: T0,
        updated_at: T0,
      })
    if (method === "GET" && path === prefix) return json(200, repoJson())
    let m = /^\/repos\/[^/]+\/[^/]+\/rules\/branches\/(.+)$/.exec(path)
    if (method === "GET" && m)
      return json(
        200,
        (await session.branchRules(m[1] as string)).map((type) => ({
          type,
          ruleset_source_type: "Repository",
          ruleset_source: REPOSITORY,
          ruleset_id: 1,
        })),
      )
    m = /\/issues\/(\d+)$/.exec(path)
    if (method === "GET" && m) {
      const number = Number(m[1])
      const state = await session.issueState(number)
      const url = `${API}${prefix}/issues/${number}`
      return json(200, {
        url,
        repository_url: `${API}${prefix}`,
        labels_url: `${url}/labels{/name}`,
        comments_url: `${url}/comments`,
        events_url: `${url}/events`,
        html_url: `${WEB}/${REPOSITORY}/issues/${number}`,
        id: 8_000_000 + number,
        node_id: `I_${number}`,
        number,
        title: "an issue",
        user: userJson("someone", 2, "User"),
        labels: [],
        state,
        state_reason: state === "closed" ? "completed" : null,
        locked: false,
        assignee: null,
        assignees: [],
        milestone: null,
        comments: 0,
        created_at: T0,
        updated_at: T0,
        closed_at: state === "closed" ? "2026-10-01T00:00:00Z" : null,
        author_association: "OWNER",
        type: null,
        active_lock_reason: null,
        sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 },
        issue_dependencies_summary: {
          blocked_by: 0,
          total_blocked_by: 0,
          blocking: 0,
          total_blocking: 0,
        },
        issue_field_values: [],
        body: "",
        closed_by: null,
        reactions: { url: `${url}/reactions`, total_count: 0 },
        timeline_url: `${url}/timeline`,
        performed_via_github_app: null,
        pinned_comment: null,
      })
    }
    m = /\/git\/ref\/heads\/(.+)$/.exec(path)
    if (method === "GET" && m) {
      const ref = `refs/heads/${m[1]}`
      const head = await session.branchHead(m[1] as string)
      return head === null
        ? json(404, notFound)
        : json(200, {
            ref,
            node_id: "REF_1",
            url: `${API}${prefix}/git/${ref}`,
            object: { sha: head, type: "commit", url: `${API}${prefix}/git/commits/${head}` },
          })
    }
    m = /\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path)
    if (method === "GET" && m) {
      const c = await session.compare(m[1] as string, m[2] as string)
      const files = c.files.map((f) => ({
        filename: f.filename,
        status: f.previousFilename ? "renamed" : "modified",
        ...(f.previousFilename ? { previous_filename: f.previousFilename } : {}),
      }))
      while (!c.complete && files.length < 300)
        files.push({ filename: `filler/${files.length}`, status: "modified" })
      const [base, head] = [m[1] as string, m[2] as string]
      const range = `${base}...${head}`
      return json(200, {
        url: `${API}${prefix}/compare/${range}`,
        html_url: `${WEB}/${REPOSITORY}/compare/${range}`,
        permalink_url: `${WEB}/${REPOSITORY}/compare/${OWNER}:${base.slice(0, 7)}...${OWNER}:${head.slice(0, 7)}`,
        diff_url: `${WEB}/${REPOSITORY}/compare/${range}.diff`,
        patch_url: `${WEB}/${REPOSITORY}/compare/${range}.patch`,
        base_commit: commitSummary(REPOSITORY, base),
        merge_base_commit: commitSummary(REPOSITORY, base),
        status: c.status,
        ahead_by: c.aheadBy,
        behind_by: 0,
        total_commits: c.aheadBy,
        commits: [],
        files,
      })
    }
    m = /\/git\/commits\/([0-9a-f]{40})$/.exec(path)
    if (method === "GET" && m) {
      const c = await session.commit(m[1] as string).catch(() => null)
      return c === null
        ? json(404, notFound)
        : json(200, {
            sha: c.sha,
            node_id: `C_${c.sha}`,
            url: `${API}${prefix}/git/commits/${c.sha}`,
            html_url: `${WEB}/${REPOSITORY}/commit/${c.sha}`,
            author: identity,
            committer: identity,
            tree: { sha: c.tree, url: `${API}${prefix}/git/trees/${c.tree}` },
            message: "m",
            parents: c.parents.map((sha) => ({
              sha,
              url: `${API}${prefix}/git/commits/${sha}`,
              html_url: `${WEB}/${REPOSITORY}/commit/${sha}`,
            })),
            verification: unverified,
          })
    }
    m = /\/git\/trees\/([0-9a-f]{40})$/.exec(path)
    if (method === "GET" && m) {
      const entries = await session.tree(m[1] as string)
      return json(200, {
        sha: m[1],
        url: `${API}${prefix}/git/trees/${m[1]}`,
        tree: entries.map((e) => ({ path: e.name, mode: e.mode, type: e.type, sha: e.sha })),
        truncated: false,
      })
    }
    if (method === "POST" && path === `${prefix}/git/blobs`)
      return json(201, {
        sha: await session.createBlob(Buffer.from(String(body.content), "base64").toString("utf8")),
        url: `${API}${prefix}/git/blobs/${ZERO_SHA}`,
      })
    if (method === "POST" && path === `${prefix}/git/trees`) {
      const sha = await session.createTree(
        String(body.base_tree),
        (body.tree as { path: string; mode: string; sha: string }[]).map((e) => ({
          path: e.path,
          mode: e.mode,
          sha: e.sha,
        })),
      )
      return json(201, { sha, url: `${API}${prefix}/git/trees/${sha}`, tree: [], truncated: false })
    }
    if (method === "POST" && path === `${prefix}/git/commits`) {
      const input = body as unknown as Parameters<DeliverySession["createCommit"]>[0]
      const sha = await session.createCommit(input)
      return json(201, {
        sha,
        node_id: `C_${sha}`,
        url: `${API}${prefix}/git/commits/${sha}`,
        html_url: `${WEB}/${REPOSITORY}/commit/${sha}`,
        author: input.author,
        committer: input.committer ?? input.author,
        tree: { sha: input.tree, url: `${API}${prefix}/git/trees/${input.tree}` },
        message: input.message,
        parents: input.parents.map((p) => ({
          sha: p,
          url: `${API}${prefix}/git/commits/${p}`,
          html_url: `${WEB}/${REPOSITORY}/commit/${p}`,
        })),
        verification: unverified,
      })
    }
    if (method === "POST" && path === `${prefix}/git/refs`) {
      const made = await session.createBranch(
        String(body.ref).replace("refs/heads/", ""),
        String(body.sha),
      )
      return made === "exists"
        ? json(422, {
            message: "Reference already exists",
            documentation_url: `${DOCS}/git/refs#create-a-reference`,
            status: "422",
          })
        : json(201, {
            ref: body.ref,
            node_id: "REF_1",
            url: `${API}${prefix}/git/${String(body.ref)}`,
            object: {
              sha: body.sha,
              type: "commit",
              url: `${API}${prefix}/git/commits/${String(body.sha)}`,
            },
          })
    }
    if (method === "GET" && path === `${prefix}/pulls`) {
      // GitHub's filter is `<owner>:<branch>`; with no owner it is ignored and every pull
      // request is listed, and another owner's branch is another head.
      const head = url.searchParams.get("head") ?? ""
      const state = url.searchParams.get("state") ?? "open"
      const colon = head.indexOf(":")
      const byHead =
        colon === -1
          ? repo.pulls
          : head.slice(0, colon) === OWNER
            ? await session.pullsByHead(head.slice(colon + 1))
            : []
      return json(
        200,
        byHead.filter((p) => state === "all" || p.state === state).map((p) => pullJson(p, false)),
      )
    }
    if (method === "POST" && path === `${prefix}/pulls`) {
      const made = await session.createDraftPull({
        title: String(body.title),
        body: String(body.body),
        head: String(body.head),
        base: String(body.base),
      })
      return made === "exists"
        ? json(422, {
            message: "Validation Failed",
            errors: [
              {
                resource: "PullRequest",
                code: "custom",
                message: `A pull request already exists for ${OWNER}:${String(body.head)}.`,
              },
            ],
            documentation_url: `${DOCS}/pulls/pulls#create-a-pull-request`,
            status: "422",
          })
        : json(201, pullJson(made, true))
    }
    m = /\/pulls\/(\d+)$/.exec(path)
    if (method === "GET" && m) {
      const number = Number(m[1])
      return repo.pulls.some((p) => p.number === number)
        ? json(200, pullJson(await session.pull(number), true))
        : json(404, notFound)
    }
    if (method === "POST" && path === "/graphql") {
      const number = Number((body.variables as Record<string, unknown> | undefined)?.number)
      if (!repo.pulls.some((p) => p.number === number))
        return json(200, {
          data: { repository: { pullRequest: null } },
          errors: [
            {
              type: "NOT_FOUND",
              path: ["repository", "pullRequest"],
              locations: [{ line: 1, column: 70 }],
              message: `Could not resolve to a PullRequest with the number of ${number}.`,
            },
          ],
        })
      return json(200, {
        data: {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: (await session.closingIssues(number)).map((n) => ({ number: n })),
              },
            },
          },
        },
      })
    }
    return json(404, { ...notFound, message: `fake GitHub has no ${method} ${path}` })
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString("utf8")
    const body = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>)
    const url = new URL(req.url ?? "/", "http://fake")
    const method = req.method ?? "GET"
    const path = `${url.pathname}${url.search}`
    const [scheme = "", credential = ""] = String(req.headers.authorization ?? "").split(" ")
    const logged: LoggedRequest = {
      method,
      path,
      auth: scheme,
      token: scheme === "token" ? tokens.indexOf(credential) : -1,
      body,
      status: 0,
    }
    requests.push(logged)
    const script = scripted.find((s) => s.method === method && s.path.test(path) && s.remaining > 0)
    let answer: { status: number; value: unknown; headers?: Readonly<Record<string, string>> }
    if (scheme === "token" && logged.token === -1) {
      answer = { status: 401, value: { message: "Bad credentials", documentation_url: DOCS } }
    } else if (script !== undefined) {
      script.remaining -= 1
      if (script.answer.after) await route(method, url, body)
      if (script.answer.delayMs !== undefined)
        await new Promise((resolve) => setTimeout(resolve, script.answer.delayMs))
      answer = {
        status: script.answer.status,
        value: script.answer.body ?? { message: `scripted ${script.answer.status}` },
        ...(script.answer.headers ? { headers: script.answer.headers } : {}),
      }
    } else {
      try {
        answer = await route(method, url, body)
      } catch (error) {
        answer = { status: 404, value: { ...notFound, message: String(error) } }
      }
    }
    logged.status = answer.status
    res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers })
    res.end(JSON.stringify(answer.value))
  }

  const http: Server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      res.writeHead(500)
      res.end(JSON.stringify({ message: String(error) }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const { port } = http.address() as AddressInfo
  const server: FakeGitHubServer = {
    url: `http://127.0.0.1:${port}`,
    repo,
    requests,
    tokens,
    granted: { contents: "write", pull_requests: "write", metadata: "read", issues: "read" },
    installed: true,
    slug: BOT.replace("[bot]", ""),
    installationId: 42,
    now: Date.now,
    pullShape: undefined,
    answer(method, path, answer, times = 1) {
      scripted.push({ method, path, answer, remaining: times })
    },
    close: () => new Promise((resolve) => http.close(() => resolve())),
  }
  return server
}
