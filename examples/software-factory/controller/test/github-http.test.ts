import { spawnSync } from "node:child_process"
import { generateKeyPairSync, verify } from "node:crypto"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { DeliveryError } from "../src/lib/delivery/adapter.ts"
import {
  allowedRoute,
  CLOSING_ISSUES_QUERY,
  DELIVERY_PERMISSIONS,
  DisallowedRequestError,
  githubRequest,
  type RequestOptions,
} from "../src/lib/delivery/github/http.ts"
import { appJwt, loadAppPrivateKey } from "../src/lib/delivery/github/jwt.ts"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const target = { repository: "cacheplane/b4run", baseBranch: "main" }
const SHA = "a".repeat(40)
const BRANCH = "factory/wo-0123456789abcdef"
const WHO = { name: "b4-factory[bot]", email: "1+b4-factory[bot]@users.noreply.github.com" }
const COMMIT = {
  message: "m",
  tree: SHA,
  parents: [SHA],
  author: { ...WHO, date: "2026-10-01T00:00:00Z" },
  committer: { ...WHO, date: "2026-10-01T00:00:00Z" },
}
const PULL = { title: "t", body: "b", head: BRANCH, base: "main", draft: true }

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe("the allow-list", () => {
  it("refuses PATCH, PUT and DELETE on every path, before any socket opens", () => {
    const paths = [
      "/repos/cacheplane/b4run/git/refs/heads/factory/wo-0123456789abcdef",
      "/repos/cacheplane/b4run/pulls/1",
      "/repos/cacheplane/b4run/pulls/1/merge",
      "/repos/cacheplane/b4run/issues/1",
      "/repos/cacheplane/b4run/releases/1",
      "/repos/cacheplane/b4run",
    ]
    for (const method of ["PATCH", "PUT", "DELETE"])
      for (const path of paths)
        expect(() => allowedRoute(method, path, {}, target)).toThrow(DisallowedRequestError)
  })

  it("refuses another repository, a ref outside factory/, a ready or misdirected PR, and any other write", () => {
    const refuse = (method: string, path: string, body?: unknown) =>
      expect(() => allowedRoute(method, path, body, target)).toThrow(DisallowedRequestError)
    for (const path of [
      `/repos/cacheplane/other/git/commits/${SHA}`,
      "/repos/cacheplane/b4run-fork/pulls/1",
    ])
      expect(() => allowedRoute("GET", path, undefined, target)).toThrow(
        /only cacheplane\/b4run is addressed/,
      )
    refuse("POST", "/repos/cacheplane/b4run/git/refs", { ref: "refs/heads/main", sha: SHA })
    refuse("POST", "/repos/cacheplane/b4run/git/refs", { ref: "refs/tags/v1", sha: SHA })
    refuse("POST", "/repos/cacheplane/b4run/git/refs", { ref: "refs/heads/factory/x", sha: SHA })
    const pull = {
      head: "factory/wo-0123456789abcdef",
      base: "main",
      draft: true,
      title: "t",
      body: "b",
    }
    refuse("POST", "/repos/cacheplane/b4run/pulls", { ...pull, draft: false })
    refuse("POST", "/repos/cacheplane/b4run/pulls", { ...pull, base: "release" })
    refuse("POST", "/repos/cacheplane/b4run/pulls", { ...pull, head: "blove/x" })
    refuse("POST", "/repos/cacheplane/b4run/issues/1/comments", { body: "x" })
    refuse("POST", "/repos/cacheplane/b4run/dispatches", { event_type: "x" })
    refuse("POST", "/repos/cacheplane/b4run/releases", { tag_name: "v1" })
    refuse("POST", "/repos/cacheplane/b4run/merges", { base: "main", head: SHA })
    refuse("POST", "/graphql", { query: "mutation { mergePullRequest }" })
    refuse("GET", "/users/blove")
    refuse("GET", "/repos/cacheplane/b4run/contents/README.md")
  })

  it("refuses a path fetch would resolve elsewhere: dot, empty and encoded segments", () => {
    for (const path of [
      "/repos/cacheplane/b4run/git/ref/heads/../../../../repos/other/secret/contents/x",
      "/repos/cacheplane/b4run/rules/branches/factory/./wo-0123456789abcdef",
      "/repos/cacheplane/b4run/rules/branches/factory/%2e%2e/x",
      "/repos/cacheplane/b4run/rules/branches/factory//x",
      "/repos/cacheplane/b4run/git/ref/heads/factory%2Fx",
    ])
      expect(() => allowedRoute("GET", path, undefined, target), path).toThrow(
        /dot, empty or encoded/,
      )
  })

  it("accepts exactly the delivery's own requests", () => {
    const accept = (method: string, path: string, body?: unknown) =>
      expect(allowedRoute(method, path, body, target).method).toBe(method)
    accept("GET", "/app")
    accept("POST", "/app/installations/42/access_tokens", {
      repositories: ["b4run"],
      permissions: { ...DELIVERY_PERMISSIONS },
    })
    accept("GET", "/repos/cacheplane/b4run/installation")
    accept("GET", `/repos/cacheplane/b4run/compare/${SHA}...${"b".repeat(40)}`)
    accept("POST", "/repos/cacheplane/b4run/git/refs", { ref: `refs/heads/${BRANCH}`, sha: SHA })
    accept("POST", "/repos/cacheplane/b4run/pulls", {
      head: BRANCH,
      base: "main",
      draft: true,
      title: "t",
      body: "b",
      maintainer_can_modify: false,
    })
    accept("POST", "/graphql", {
      query: CLOSING_ISSUES_QUERY,
      variables: { owner: "cacheplane", name: "b4run", number: 7 },
    })
    accept("POST", "/repos/cacheplane/b4run/git/blobs", { content: "aGk=", encoding: "base64" })
    accept("POST", "/repos/cacheplane/b4run/git/trees", {
      base_tree: SHA,
      tree: [{ path: "src/a.ts", mode: "100644", type: "blob", sha: SHA }],
    })
    accept("POST", "/repos/cacheplane/b4run/git/commits", COMMIT)
    accept("GET", `/users/${encodeURIComponent("b4-factory[bot]")}`)
  })
})

describe("the app's credential", () => {
  const thrown = (fn: () => unknown): string => {
    try {
      fn()
    } catch (e) {
      return String(e)
    }
    return ""
  }

  it("refuses a key that is not RSA, naming the path and never the key", () => {
    dir = mkdtempSync(join(tmpdir(), "app-key-"))
    const path = join(dir, "app.pem")
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey
    const pem = ec.export({ type: "pkcs8", format: "pem" }).toString()
    writeFileSync(path, pem, { mode: 0o600 })
    const error = thrown(() => loadAppPrivateKey(path))
    expect(/not an RSA private key/.test(error)).toBe(true)
    expect(error.includes(path)).toBe(true)
    expect(error.includes(pem.split("\n")[1] as string)).toBe(false)
    expect(/RSA/.test(thrown(() => appJwt(1, ec, Date.now())))).toBe(true)
  })

  it("refuses a key any group or other bit can reach", () => {
    dir = mkdtempSync(join(tmpdir(), "app-key-"))
    const path = join(dir, "app.pem")
    writeFileSync(path, privateKey.export({ type: "pkcs1", format: "pem" }).toString(), {
      mode: 0o600,
    })
    for (const mode of [0o604, 0o640, 0o601, 0o610]) {
      chmodSync(path, mode)
      expect(/chmod 600/.test(thrown(() => loadAppPrivateKey(path)))).toBe(true)
    }
    chmodSync(path, 0o400)
    expect(loadAppPrivateKey(path).asymmetricKeyType === "rsa").toBe(true)
  })

  it("signs an RS256 JWT GitHub accepts: issued a minute ago, nine minutes to live", () => {
    const now = Date.parse("2026-10-01T12:00:00Z")
    const [header, payload, signature] = appJwt(123456, privateKey, now).split(".") as [
      string,
      string,
      string,
    ]
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    })
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
      iat: now / 1000 - 60,
      exp: now / 1000 + 540,
      iss: 123456,
    })
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true)
  })

  it("reads only a private, regular PEM file, and never quotes it", () => {
    dir = mkdtempSync(join(tmpdir(), "app-key-"))
    const path = join(dir, "app.pem")
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString()
    writeFileSync(path, pem, { mode: 0o600 })
    expect(loadAppPrivateKey(path).asymmetricKeyType).toBe("rsa")
    chmodSync(path, 0o644)
    expect(() => loadAppPrivateKey(path)).toThrow(/chmod 600/)
    writeFileSync(path, "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n", { mode: 0o600 })
    chmodSync(path, 0o600)
    const error = (() => {
      try {
        loadAppPrivateKey(path)
      } catch (e) {
        return String(e)
      }
    })()
    expect(error).toContain("is not a PEM private key")
    expect(error).not.toContain("not a key")
    expect(() => loadAppPrivateKey(dir as string)).toThrow(/cannot be used/)
  })

  // A FIFO at the key's path must not block the controller: the open would wait for a writer.
  // The load runs in a child process so a regression times out instead of hanging the suite.
  const mkfifo = process.platform === "win32" ? undefined : spawnSync("mkfifo", ["--version"])
  it.skipIf(mkfifo === undefined || (mkfifo.error as NodeJS.ErrnoException)?.code === "ENOENT")(
    "refuses a FIFO at the key's path promptly, never waiting for a writer",
    () => {
      dir = mkdtempSync(join(tmpdir(), "app-key-"))
      const path = join(dir, "app.pem")
      expect(spawnSync("mkfifo", ["-m", "600", path]).status).toBe(0)
      const jwt = fileURLToPath(new URL("../src/lib/delivery/github/jwt.ts", import.meta.url))
      const script = `import { loadAppPrivateKey } from ${JSON.stringify(jwt)}
try { loadAppPrivateKey(${JSON.stringify(path)}); console.log("loaded") } catch (e) { console.log(String(e)) }`
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        timeout: 10_000,
      })
      expect(child.signal).toBe(null)
      expect(child.stdout).toContain("not a regular file")
    },
    20_000,
  )
})

describe("a POST body is checked exactly, in the form it is sent", () => {
  const refuse = (path: string, body: unknown, why?: RegExp) =>
    expect(() => allowedRoute("POST", path, body, target), JSON.stringify(body)).toThrow(
      why ?? DisallowedRequestError,
    )
  const repo = "/repos/cacheplane/b4run"
  const mint = "/app/installations/42/access_tokens"

  it("a ref: exactly { ref, sha }", () => {
    const ref = { ref: `refs/heads/${BRANCH}`, sha: SHA }
    refuse(`${repo}/git/refs`, { ...ref, force: true })
    refuse(`${repo}/git/refs`, { ...ref, sha: "main" })
    refuse(`${repo}/git/refs`, { ref: ref.ref })
  })

  it("a pull request: title, body, head, base, draft and no other field", () => {
    refuse(`${repo}/pulls`, { ...PULL, issue: 7 })
    refuse(`${repo}/pulls`, { ...PULL, head_repo: "cacheplane/other" })
    refuse(`${repo}/pulls`, { ...PULL, maintainer_can_modify: true })
    refuse(`${repo}/pulls`, { ...PULL, title: 7 })
    refuse(`${repo}/pulls`, { ...PULL, body: undefined })
  })

  it("the token mint: the configured repository alone, the delivery permissions exactly", () => {
    const body = { repositories: ["b4run"], permissions: { ...DELIVERY_PERMISSIONS } }
    refuse(mint, {}, /only b4run/)
    refuse(mint, { permissions: body.permissions }, /only b4run/)
    refuse(mint, { ...body, repositories: ["other"] }, /only b4run/)
    refuse(mint, { ...body, repositories: ["b4run", "other"] }, /only b4run/)
    refuse(mint, { ...body, repository_ids: [1] })
    refuse(mint, { repositories: ["b4run"] }, /permissions/)
    refuse(mint, { ...body, permissions: { ...body.permissions, administration: "write" } })
    refuse(mint, { ...body, permissions: { ...body.permissions, issues: "write" } })
    const { issues: _issues, ...fewer } = body.permissions
    refuse(mint, { ...body, permissions: fewer })
  })

  it("the GraphQL read: the fixed query, for the configured repository only", () => {
    const variables = { owner: "cacheplane", name: "b4run", number: 7 }
    refuse("/graphql", { query: CLOSING_ISSUES_QUERY })
    refuse("/graphql", { query: CLOSING_ISSUES_QUERY, variables: { ...variables, owner: "x" } })
    refuse("/graphql", { query: CLOSING_ISSUES_QUERY, variables: { ...variables, name: "x" } })
    refuse("/graphql", { query: CLOSING_ISSUES_QUERY, variables: { ...variables, number: "7" } })
    refuse("/graphql", { query: CLOSING_ISSUES_QUERY, variables: { ...variables, extra: 1 } })
    refuse("/graphql", { query: CLOSING_ISSUES_QUERY, variables, operationName: "x" })
  })

  it("git objects: a base64 blob, blob entries on a base tree, a commit of exactly its fields", () => {
    refuse(`${repo}/git/blobs`, { content: "x", encoding: "utf-8" })
    refuse(`${repo}/git/blobs`, { content: "x", encoding: "base64", extra: 1 })
    const entry = { path: "a.ts", mode: "100644", type: "blob", sha: SHA }
    refuse(`${repo}/git/trees`, { tree: [entry] })
    refuse(`${repo}/git/trees`, { base_tree: SHA, tree: [{ ...entry, mode: "160000" }] })
    refuse(`${repo}/git/trees`, { base_tree: SHA, tree: [{ ...entry, type: "commit" }] })
    refuse(`${repo}/git/trees`, { base_tree: SHA, tree: [{ ...entry, content: "x" }] })
    refuse(`${repo}/git/trees`, { base_tree: SHA, tree: [{ ...entry, sha: null }] })
    refuse(`${repo}/git/commits`, { ...COMMIT, signature: "x" })
    refuse(`${repo}/git/commits`, { ...COMMIT, parents: ["main"] })
    refuse(`${repo}/git/commits`, { ...COMMIT, author: { ...COMMIT.author, extra: 1 } })
    const { committer: _c, ...noCommitter } = COMMIT
    refuse(`${repo}/git/commits`, noCommitter)
  })

  it("a GET carries no body, and a POST always carries one", () => {
    expect(() => allowedRoute("GET", "/app", {}, target)).toThrow(/carries no body/)
    expect(() => allowedRoute("POST", `${repo}/git/refs`, undefined, target)).toThrow(
      /body is required/,
    )
  })

  it("refuses a login that does not decode, as a disallowed request", () => {
    expect(() => allowedRoute("GET", "/users/%E0%A4%A", undefined, target)).toThrow(
      DisallowedRequestError,
    )
  })
})

/** A loopback server that answers with `handler` and counts what reached it. */
async function loopback(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const hits: { url: string; body: string }[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      hits.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") })
      handler(req, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const close = () => {
    server.closeAllConnections()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return { url, hits, close }
}

let closeServer: (() => Promise<void>) | undefined
afterEach(async () => {
  await closeServer?.()
  closeServer = undefined
})

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const s = await loopback(handler)
  closeServer = s.close
  return s
}

const credentials = { minted: 0 }
const options = (baseUrl: string, overrides: Partial<RequestOptions> = {}): RequestOptions => ({
  fetch,
  baseUrl,
  target,
  credential: () => {
    credentials.minted += 1
    return "credential-value"
  },
  signal: new AbortController().signal,
  now: () => 1_000_000,
  timeoutMs: 300,
  ...overrides,
})

const failure = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("the request succeeded")
}
const kind = (error: Error) => (error instanceof DeliveryError ? error.kind : error.name)
const json =
  (status: number, value: unknown, headers: Record<string, string> = {}) =>
  (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(status, { "content-type": "application/json", ...headers })
    res.end(JSON.stringify(value))
  }

describe("one request on the wire", () => {
  it("sends the body it checked: a toJSON that turns into another ref is refused unsent", async () => {
    const s = await serve(json(201, { ref: "x" }))
    const disguised = {
      ref: `refs/heads/${BRANCH}`,
      sha: SHA,
      toJSON: () => ({ ref: "refs/heads/main", sha: SHA }),
    }
    // The same, with the toJSON out of sight on the prototype: the object's own keys are a
    // valid ref, and only the bytes JSON.stringify writes are not.
    const inherited = Object.assign(
      Object.create({ toJSON: () => ({ ref: "refs/heads/main", sha: SHA }) }) as object,
      { ref: `refs/heads/${BRANCH}`, sha: SHA },
    )
    for (const body of [disguised, inherited]) {
      const error = await failure(
        githubRequest(options(s.url), "POST", "/repos/cacheplane/b4run/git/refs", body),
      )
      expect(error).toBeInstanceOf(DisallowedRequestError)
    }
    expect(s.hits).toHaveLength(0)
    const ref = { ref: `refs/heads/${BRANCH}`, sha: SHA }
    await githubRequest(options(s.url), "POST", "/repos/cacheplane/b4run/git/refs", ref)
    expect(s.hits.map((h) => h.body)).toEqual([JSON.stringify(ref)])
  })

  it("refuses a URL that resolves elsewhere before a credential is made or a socket opens", async () => {
    const s = await serve(json(200, { slug: "b4-factory" }))
    credentials.minted = 0
    for (const base of [`${s.url}/`, `${s.url}?x=`, `${s.url}#`])
      expect(await failure(githubRequest(options(base), "GET", "/app"))).toBeInstanceOf(
        DisallowedRequestError,
      )
    expect(s.hits).toHaveLength(0)
    expect(credentials.minted).toBe(0)
    expect(await failure(githubRequest(options(s.url), "GET", "/app?x=1"))).toBeInstanceOf(
      DisallowedRequestError,
    )
    // A query fetch would re-encode is not the query that was checked.
    const listing = `/repos/cacheplane/b4run/pulls?head=cacheplane:a b&state=all&per_page=100`
    expect(await failure(githubRequest(options(s.url), "GET", listing))).toBeInstanceOf(
      DisallowedRequestError,
    )
    expect(s.hits).toHaveLength(0)
    await githubRequest(options(s.url), "GET", "/app")
    expect(s.hits.map((h) => h.url)).toEqual(["/app"])
  })

  it("never follows a redirect: a 3xx is unexpected and the target is never asked", async () => {
    const s = await serve((req, res) => {
      res.writeHead(req.url === "/app" ? 302 : 200, { location: "/app/elsewhere" })
      res.end("{}")
    })
    const error = await failure(githubRequest(options(s.url), "GET", "/app"))
    expect(kind(error)).toBe("unexpected")
    expect((error as DeliveryError).status).toBe(302)
    expect(error.message).toMatch(/redirect, not followed/)
    expect(s.hits.map((h) => h.url)).toEqual(["/app"])
  })

  it("bounds a request: no answer within the timeout is transient", async () => {
    const s = await serve(() => {})
    const started = Date.now()
    const error = await failure(githubRequest(options(s.url, { timeoutMs: 200 }), "GET", "/app"))
    expect(kind(error)).toBe("transient")
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it("bounds the body too: a body that stalls past the timeout is transient", async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.write('{"a":')
    })
    const error = await failure(githubRequest(options(s.url, { timeoutMs: 300 }), "GET", "/app"))
    expect(kind(error)).toBe("transient")
  })

  it("a connection reset in the middle of the body is transient", async () => {
    const s = await serve((req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.write('{"a":')
      setTimeout(() => req.socket.destroy(), 50)
    })
    const error = await failure(githubRequest(options(s.url, { timeoutMs: 2000 }), "GET", "/app"))
    expect(kind(error)).toBe("transient")
  })

  it("the controller closing is the caller's to see, before or during the body (D26)", async () => {
    const before = await loopback(() => {})
    const during = await loopback((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.write('{"a":')
    })
    try {
      for (const s of [before, during]) {
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 100)
        const error = await failure(
          githubRequest(
            options(s.url, { signal: controller.signal, timeoutMs: 5000 }),
            "GET",
            "/app",
          ),
        )
        expect(error).not.toBeInstanceOf(DeliveryError)
        expect(error.name).toBe("AbortError")
      }
    } finally {
      await before.close()
      await during.close()
    }
  })

  it("classifies a rate limit, including GitHub's secondary limit without a retry-after", async () => {
    let s = await serve(json(429, { message: "slow down" }, { "retry-after": "7" }))
    let error = await failure(githubRequest(options(s.url), "GET", "/app"))
    expect(kind(error)).toBe("rate_limited")
    expect((error as DeliveryError).retryAfterMs).toBe(7000)
    await closeServer?.()
    s = await serve(
      json(
        403,
        { message: "You have exceeded a secondary rate limit." },
        { "x-ratelimit-remaining": "4000" },
      ),
    )
    error = await failure(githubRequest(options(s.url), "GET", "/app"))
    expect(kind(error)).toBe("rate_limited")
    expect((error as DeliveryError).retryAfterMs).toBe(60_000)
    await closeServer?.()
    s = await serve(json(403, { message: "Resource not accessible by integration" }))
    error = await failure(githubRequest(options(s.url), "GET", "/app"))
    expect(kind(error)).toBe("unauthorized")
  })

  it("carries GitHub's errors[] messages, cleaned and capped, beside its top-level message", async () => {
    // GitHub's 422 for a pull request that exists says so only in errors[].
    let s = await serve(
      json(422, {
        message: "Validation Failed",
        errors: [
          {
            resource: "PullRequest",
            code: "custom",
            message: `A pull request already exists for cacheplane:${BRANCH}.`,
          },
          { resource: "PullRequest", code: "missing_field", field: "head" },
          { message: `line\u0000one\nline two\u001b[31m ${"x".repeat(1000)}` },
        ],
      }),
    )
    let error = await failure(githubRequest(options(s.url), "GET", "/app"))
    expect(kind(error)).toBe("conflict")
    expect(error.message).toContain(
      `HTTP 422 Validation Failed: A pull request already exists for cacheplane:${BRANCH}.`,
    )
    // biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control characters is the point
    expect(/[\u0000-\u001f\u007f]/.test(error.message)).toBe(false)
    expect(error.message).toContain("line one line two [31m x")
    expect(error.message.length).toBeLessThan(900)
    await closeServer?.()
    // Many errors: only the first few are kept.
    s = await serve(
      json(422, {
        message: "Validation Failed",
        errors: Array.from({ length: 50 }, (_, i) => ({ message: `problem ${i}` })),
      }),
    )
    error = await failure(githubRequest(options(s.url), "GET", "/app"))
    expect(error.message).toContain("problem 2")
    expect(error.message).not.toContain("problem 3")
  })

  it("a 2xx body that is not JSON, or larger than the bound, is unexpected; a 204 is empty", async () => {
    let s = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end("<html>")
    })
    expect(kind(await failure(githubRequest(options(s.url), "GET", "/app")))).toBe("unexpected")
    await closeServer?.()
    s = await serve(json(200, { padding: "x".repeat(4096) }))
    const large = await failure(
      githubRequest(options(s.url, { maxBodyBytes: 1024 }), "GET", "/app"),
    )
    expect(kind(large)).toBe("unexpected")
    expect(large.message).toMatch(/more than 1024 bytes/)
    await closeServer?.()
    s = await serve((_req, res) => {
      res.writeHead(204)
      res.end()
    })
    expect(await githubRequest(options(s.url), "GET", "/app")).toEqual({ status: 204, json: null })
  })
})
