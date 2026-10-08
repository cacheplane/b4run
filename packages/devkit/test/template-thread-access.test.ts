import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const templates = ["app-basic", "app-navlog"] as const

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

/**
 * Where each template's app tree starts. `app-navlog` is an npm workspace,
 * so its `src/` — and the authorization files in it — live under `server/`.
 */
const appRoot = (name: string): string => (name === "app-navlog" ? `${name}/server` : name)

/**
 * Where each template keeps its policy. `app-basic` ships it inert, one rename
 * from active. `app-navlog` ships it active: its `src/auth.ts` resolves one
 * local principal when no proxy guards the server, so it is inert in
 * development and per-visitor behind the deployed demo's proxy.
 */
const policyFile = (name: string): string =>
  name === "app-navlog" ? "src/thread-access.ts" : "src/thread-access.ts.example"
const authFile = (name: string): string =>
  name === "app-navlog" ? "src/auth.ts" : "src/auth.ts.example"

const navlogTemplateSrc = fileURLToPath(
  new URL("../templates/app-navlog/server/src/", import.meta.url),
)
const navlogExampleSrc = `${resolve(repoRoot, "examples/navlog/server/src")}/`

/** The policy's code from its first import on: what activation must not change. */
const policyBody = (source: string): string => {
  const start = source.indexOf("import { defineThreadAccess")
  // A missing marker would slice from -1 and compare two one-character tails.
  expect(start).toBeGreaterThanOrEqual(0)
  return source.slice(start)
}

const read = (name: string, file: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../templates/${appRoot(name)}/${file}`, import.meta.url)),
    "utf8",
  )

const exists = (name: string, file: string): boolean =>
  existsSync(fileURLToPath(new URL(`../templates/${appRoot(name)}/${file}`, import.meta.url)))

/** Line-oriented and deliberately crude: enough to tell code from commentary. */
const stripComments = (source: string): string =>
  source
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim()
      return !(
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        trimmed === ""
      )
    })
    .join("\n")

describe("scaffolded thread-access policy", () => {
  for (const name of templates) {
    it(`${name} ships a deny-by-default policy and the shared auth module`, () => {
      const policy = read(name, policyFile(name))

      expect(policy).toContain("defineThreadAccess")
      // `fallback` is the deny-by-default floor: an action with no handler of
      // its own lands there rather than falling through to an allow.
      expect(policy).toContain("fallback: owned")
      // The DELETE existence oracle: a missing row is denied ahead of any admin
      // branch, so "not yours" and "never existed" answer identically.
      expect(policy).toContain("if (req.thread === undefined) return deny()")
      // One resolver, enforced: src/auth.ts default-exports `defineAuth`, and
      // the policy reads the principal it resolved instead of parsing a header.
      expect(read(name, authFile(name))).toContain("export default defineAuth(")
      expect(policy).toContain("req.principal")
      expect(stripComments(policy)).not.toContain("headers")
      expect(policy).not.toContain('from "./auth.js"')
    })

    it(`${name}'s policy authorizes against the server stamp, never client metadata`, () => {
      const policy = read(name, policyFile(name))

      expect(policy).toContain("req.thread.access?.ownerId")
      // `thread.metadata` is client-supplied and untrusted. A scaffold that
      // read the owner out of it would ship the forgery it exists to prevent.
      // Comments are stripped first — the file explains the rule, in prose that
      // necessarily names the field it forbids.
      expect(stripComments(policy)).not.toContain("thread.metadata")
    })

    it(`${name} says what the missing-row deny does and does not reach`, () => {
      const policy = read(name, policyFile(name))

      // The deny on `req.thread === undefined` is justified in this file on
      // DELETE-existence-oracle grounds, and the obvious misreading of it is
      // that it also refuses every AG-UI turn on a browser-chosen `threadId`.
      // It does not: a run endpoint that finds no row asks under `create`, and
      // the row it writes carries that decision's stamp. A scaffold whose
      // commentary describes a first-class flow wrongly gets copied, then
      // cursed.
      expect(policy).toContain("/agui/")
      expect(policy).toContain('`action: "create"`')
      // And the cost that comes with it, which is the one thing a reader
      // cannot infer from the code: the ids are client-chosen, so whoever
      // names an unused one owns it, and can deny it to the caller who meant
      // to use it. `POST /threads` mints ids nobody can call first.
      expect(policy).toContain("first come, first served")
      expect(policy).toContain("POST /threads")
    })
  }

  it("app-basic leaves the policy inert until the app renames it", () => {
    // Deliberate: the template is also the quickstart and the base fixture for
    // the Agent Protocol runtime harness, and an active deny-by-default policy
    // denies every request from an app that has no authenticated caller yet.
    // The scaffold is one `mv` from active, and the file says so.
    expect(exists("app-basic", "src/thread-access.ts")).toBe(false)
    expect(exists("app-basic", "src/auth.ts")).toBe(false)
    expect(read("app-basic", "src/thread-access.ts.example")).toContain(
      "Rename to `src/thread-access.ts`",
    )
  })

  it("app-navlog ships the policy active, inert in development", () => {
    expect(exists("app-navlog", "src/thread-access.ts.example")).toBe(false)
    expect(exists("app-navlog", "src/auth.ts.example")).toBe(false)
    const auth = read("app-navlog", "src/auth.ts")
    // No proxy token, no per-visitor principal: one local principal owns
    // everything, which is what `b4 dev` and the harness lanes run with.
    expect(auth).toContain("const token = process.env.B4_INTERNAL_TOKEN")
    expect(auth).toContain("if (!token) return")
    // With a token configured, the visitor header counts only beside it, so
    // the policy holds even without the example's main.mjs in front.
    expect(auth).toContain('sameSecret(headers["x-internal-token"], token)')
    expect(auth).toContain("LOCAL_PRINCIPAL")
    // An untokened request is refused before any endpoint, by the resolver
    // itself; there is no route middleware left to do it.
    expect(auth).toContain('reject(401, { error: "unauthorized" })')
    expect(exists("app-navlog", "src/middleware.ts")).toBe(false)
  })

  it("app-navlog's active policy is the scaffold's policy, unchanged below its header", () => {
    expect(policyBody(read("app-navlog", "src/thread-access.ts"))).toBe(
      policyBody(read("app-basic", "src/thread-access.ts.example")),
    )
  })

  it("keeps the navlog example and template authorization files in byte-for-byte parity", () => {
    for (const file of ["thread-access.ts", "auth.ts"]) {
      // Two copies of an authorization module that drift are two different
      // security postures, only one of which anybody reviewed.
      expect(readFileSync(`${navlogTemplateSrc}${file}`, "utf8")).toBe(
        readFileSync(`${navlogExampleSrc}${file}`, "utf8"),
      )
    }
  })
})
