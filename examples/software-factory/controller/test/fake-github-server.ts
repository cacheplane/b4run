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

export async function startFakeGitHubServer(): Promise<FakeGitHubServer> {
  const repo = createFakeGitHub()
  const session = await repo.open(REPOSITORY, new AbortController().signal)
  const scripted: { method: string; path: RegExp; answer: ScriptedAnswer; remaining: number }[] = []
  const requests: LoggedRequest[] = []
  const tokens: string[] = []
  const [OWNER] = REPOSITORY.split("/") as [string, string]
  const prefix = `/repos/${REPOSITORY}`

  const pullJson = (p: Awaited<ReturnType<DeliverySession["pull"]>>, single: boolean) => {
    const json: Record<string, unknown> = {
      url: `https://api.github.com${prefix}/pulls/${p.number}`,
      id: 9_000_000 + p.number,
      number: p.number,
      html_url: p.url,
      node_id: p.nodeId,
      state: p.state,
      locked: false,
      title: "t",
      draft: p.draft,
      merged_at: p.merged ? "2026-10-01T00:00:00Z" : null,
      closed_at: p.state === "closed" ? "2026-10-01T00:00:00Z" : null,
      user: { login: p.author, id: 123, type: p.author.endsWith("[bot]") ? "Bot" : "User" },
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
      // Only the single pull request carries `merged`; a listing has `merged_at` alone.
      ...(single ? { merged: p.merged, mergeable: null } : {}),
    }
    return server.pullShape ? server.pullShape(json) : json
  }

  async function route(method: string, url: URL, body: Record<string, unknown>) {
    const path = url.pathname
    const json = (status: number, value: unknown) => ({ status, value })
    if (method === "GET" && path === "/app")
      return json(200, { id: 123456, slug: server.slug, name: server.slug })
    if (method === "GET" && path === `${prefix}/installation`)
      return server.installed
        ? json(200, {
            id: server.installationId,
            app_slug: server.slug,
            account: { login: OWNER },
            repository_selection: "selected",
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
      })
    }
    if (method === "GET" && path === `/users/${encodeURIComponent(BOT)}`)
      return json(200, { login: BOT, id: 123, type: "Bot" })
    if (method === "GET" && path === prefix)
      return json(200, { id: 1, full_name: REPOSITORY, default_branch: "main", private: false })
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
    if (method === "GET" && m)
      return json(200, {
        number: Number(m[1]),
        state: await session.issueState(Number(m[1])),
        title: "an issue",
      })
    m = /\/git\/ref\/heads\/(.+)$/.exec(path)
    if (method === "GET" && m) {
      const ref = `refs/heads/${m[1]}`
      const head = await session.branchHead(m[1] as string)
      return head === null
        ? json(404, notFound)
        : json(200, { ref, node_id: "REF_1", object: { sha: head, type: "commit" } })
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
      return json(200, { status: c.status, ahead_by: c.aheadBy, behind_by: 0, files })
    }
    m = /\/git\/commits\/([0-9a-f]{40})$/.exec(path)
    if (method === "GET" && m) {
      const c = await session.commit(m[1] as string).catch(() => null)
      return c === null
        ? json(404, notFound)
        : json(200, {
            sha: c.sha,
            node_id: `C_${c.sha}`,
            tree: { sha: c.tree },
            parents: c.parents.map((sha) => ({ sha })),
            message: "m",
          })
    }
    m = /\/git\/trees\/([0-9a-f]{40})$/.exec(path)
    if (method === "GET" && m) {
      const entries = await session.tree(m[1] as string)
      return json(200, {
        sha: m[1],
        truncated: false,
        tree: entries.map((e) => ({ path: e.name, mode: e.mode, type: e.type, sha: e.sha })),
      })
    }
    if (method === "POST" && path === `${prefix}/git/blobs`)
      return json(201, {
        sha: await session.createBlob(Buffer.from(String(body.content), "base64").toString("utf8")),
        url: `https://api.github.com${prefix}/git/blobs/x`,
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
      return json(201, { sha, truncated: false, tree: [] })
    }
    if (method === "POST" && path === `${prefix}/git/commits`) {
      const input = body as unknown as Parameters<DeliverySession["createCommit"]>[0]
      const sha = await session.createCommit(input)
      return json(201, {
        sha,
        node_id: `C_${sha}`,
        author: input.author,
        committer: input.committer ?? input.author,
        message: input.message,
        tree: { sha: input.tree },
        parents: input.parents.map((p) => ({ sha: p })),
        verification: { verified: false, reason: "unsigned" },
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
        : json(201, { ref: body.ref, node_id: "REF_1", object: { sha: body.sha, type: "commit" } })
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
