import { generateKeyPairSync, verify } from "node:crypto"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  allowedRoute,
  CLOSING_ISSUES_QUERY,
  DisallowedRequestError,
} from "../src/lib/delivery/github/http.ts"
import { appJwt, loadAppPrivateKey } from "../src/lib/delivery/github/jwt.ts"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const target = { repository: "cacheplane/b4run", baseBranch: "main" }
const SHA = "a".repeat(40)
const BRANCH = "factory/wo-0123456789abcdef"

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
    refuse("GET", `/repos/cacheplane/other/git/commits/${SHA}`)
    refuse("GET", "/repos/cacheplane/b4run-fork/pulls/1")
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
    accept("POST", "/app/installations/42/access_tokens", { repositories: ["b4run"] })
    accept("GET", "/repos/cacheplane/b4run/installation")
    accept("GET", `/repos/cacheplane/b4run/compare/${SHA}...${"b".repeat(40)}`)
    accept("POST", "/repos/cacheplane/b4run/git/refs", { ref: `refs/heads/${BRANCH}`, sha: SHA })
    accept("POST", "/repos/cacheplane/b4run/pulls", {
      head: BRANCH,
      base: "main",
      draft: true,
      title: "t",
      body: "b",
    })
    accept("POST", "/graphql", { query: CLOSING_ISSUES_QUERY, variables: {} })
    accept("GET", `/users/${encodeURIComponent("b4-factory[bot]")}`)
  })
})

describe("the app's credential", () => {
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
})
