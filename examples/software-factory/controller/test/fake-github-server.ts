import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { DeliverySession } from "../src/lib/delivery/adapter.ts"
import { BOT, createFakeGitHub, type FakeGitHub, REPOSITORY } from "./fake-delivery-adapter.ts"

/**
 * GitHub's REST and GraphQL endpoints as the real adapter calls them, on loopback, backed by
 * the in-memory repository of `fake-delivery-adapter.ts`. It answers in GitHub's shapes and
 * status codes (201 on create, 422 "Reference already exists", 422 "A pull request already
 * exists", 404 for a missing ref) so the adapter's mapping is tested against them, and it can
 * be told to answer any request with a scripted status and headers instead. Every request is
 * logged with its method, path, authorization scheme and body.
 */

export const INSTALLATION_TOKEN = "ghs_fakeinstallationtokenfake0001"

export interface ScriptedAnswer {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: unknown
  /** Perform the request first, then answer this: a response lost after the write. */
  readonly after?: boolean
  /** Hold the answer this long: a request past the adapter's per-request bound. */
  readonly delayMs?: number
}

export interface FakeGitHubServer {
  readonly url: string
  readonly repo: FakeGitHub
  readonly requests: { method: string; path: string; auth: string; body: unknown }[]
  /** Permissions the mint grants; the delivery set by default. */
  granted: Record<string, string>
  installed: boolean
  answer(method: string, path: RegExp, answer: ScriptedAnswer, times?: number): void
  close(): Promise<void>
}

export async function startFakeGitHubServer(): Promise<FakeGitHubServer> {
  const repo = createFakeGitHub()
  const session = await repo.open(REPOSITORY, new AbortController().signal)
  const scripted: { method: string; path: RegExp; answer: ScriptedAnswer; remaining: number }[] = []
  const requests: FakeGitHubServer["requests"] = []
  const prefix = `/repos/${REPOSITORY}`

  const pullJson = (p: Awaited<ReturnType<DeliverySession["pull"]>>) => ({
    number: p.number,
    html_url: p.url,
    node_id: p.nodeId,
    state: p.state,
    draft: p.draft,
    merged_at: p.merged ? "2026-10-01T00:00:00Z" : null,
    user: { login: p.author },
    head: { ref: p.headRef, sha: p.headSha, repo: { full_name: p.headRepository } },
    base: { ref: p.baseRef },
  })

  async function route(method: string, url: URL, body: Record<string, unknown>) {
    const path = url.pathname
    const json = (status: number, value: unknown) => ({ status, value })
    if (method === "GET" && path === "/app") return json(200, { slug: BOT.replace("[bot]", "") })
    if (method === "GET" && path === `${prefix}/installation`)
      return server.installed ? json(200, { id: 42 }) : json(404, { message: "Not Found" })
    if (method === "POST" && path === "/app/installations/42/access_tokens")
      return json(201, { token: INSTALLATION_TOKEN, permissions: server.granted })
    if (method === "GET" && path === `/users/${encodeURIComponent(BOT)}`)
      return json(200, { id: 123 })
    if (method === "GET" && path === prefix) return json(200, { full_name: REPOSITORY })
    let m = /^\/repos\/[^/]+\/[^/]+\/rules\/branches\/(.+)$/.exec(path)
    if (method === "GET" && m)
      return json(
        200,
        (await session.branchRules(m[1] as string)).map((type) => ({ type })),
      )
    m = /\/issues\/(\d+)$/.exec(path)
    if (method === "GET" && m) return json(200, { state: await session.issueState(Number(m[1])) })
    m = /\/git\/ref\/heads\/(.+)$/.exec(path)
    if (method === "GET" && m) {
      const head = await session.branchHead(m[1] as string)
      return head === null
        ? json(404, { message: "Not Found" })
        : json(200, { object: { sha: head } })
    }
    m = /\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path)
    if (method === "GET" && m) {
      const c = await session.compare(m[1] as string, m[2] as string)
      const files = c.files.map((f) => ({
        filename: f.filename,
        ...(f.previousFilename ? { previous_filename: f.previousFilename } : {}),
      }))
      while (!c.complete && files.length < 300) files.push({ filename: `filler/${files.length}` })
      return json(200, { status: c.status, ahead_by: c.aheadBy, files })
    }
    m = /\/git\/commits\/([0-9a-f]{40})$/.exec(path)
    if (method === "GET" && m) {
      const c = await session.commit(m[1] as string).catch(() => null)
      return c === null
        ? json(404, { message: "Not Found" })
        : json(200, {
            sha: c.sha,
            tree: { sha: c.tree },
            parents: c.parents.map((sha) => ({ sha })),
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
      })
    if (method === "POST" && path === `${prefix}/git/trees`)
      return json(201, {
        sha: await session.createTree(
          String(body.base_tree),
          (body.tree as { path: string; mode: string; sha: string }[]).map((e) => ({
            path: e.path,
            mode: e.mode,
            sha: e.sha,
          })),
        ),
      })
    if (method === "POST" && path === `${prefix}/git/commits`)
      return json(201, {
        sha: await session.createCommit(
          body as unknown as Parameters<DeliverySession["createCommit"]>[0],
        ),
      })
    if (method === "POST" && path === `${prefix}/git/refs`) {
      const made = await session.createBranch(
        String(body.ref).replace("refs/heads/", ""),
        String(body.sha),
      )
      return made === "exists"
        ? json(422, { message: "Reference already exists" })
        : json(201, { ref: body.ref, object: { sha: body.sha } })
    }
    if (method === "GET" && path === `${prefix}/pulls`) {
      const head = (url.searchParams.get("head") ?? "").replace(/^[^:]+:/, "")
      return json(200, (await session.pullsByHead(head)).map(pullJson))
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
            message: "Validation Failed: A pull request already exists for cacheplane:x.",
          })
        : json(201, pullJson(made))
    }
    m = /\/pulls\/(\d+)$/.exec(path)
    if (method === "GET" && m) return json(200, pullJson(await session.pull(Number(m[1]))))
    if (method === "POST" && path === "/graphql")
      return json(200, {
        data: {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: (await session.closingIssues(0)).map((number) => ({ number })),
              },
            },
          },
        },
      })
    return json(404, { message: `fake GitHub has no ${method} ${path}` })
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString("utf8")
    const body = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>)
    const url = new URL(req.url ?? "/", "http://fake")
    const method = req.method ?? "GET"
    const path = `${url.pathname}${url.search}`
    requests.push({
      method,
      path,
      auth: String(req.headers.authorization ?? "").split(" ")[0] ?? "",
      body,
    })
    const script = scripted.find((s) => s.method === method && s.path.test(path) && s.remaining > 0)
    let answer: { status: number; value: unknown; headers?: Readonly<Record<string, string>> }
    if (script !== undefined) {
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
        answer = { status: 404, value: { message: String(error) } }
      }
    }
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
    granted: { contents: "write", pull_requests: "write", metadata: "read", issues: "read" },
    installed: true,
    answer(method, path, answer, times = 1) {
      scripted.push({ method, path, answer, remaining: times })
    },
    close: () => new Promise((resolve) => http.close(() => resolve())),
  }
  return server
}
