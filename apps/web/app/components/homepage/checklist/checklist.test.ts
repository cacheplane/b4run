import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createProgram } from "@b4run/cli"
import { extractToolSchemasForRoute } from "@b4run/core/node"
import type { PermissionDecision } from "@b4run/permissions"
import {
  createPostgresPermissionsStore,
  createPostgresThreadsStore,
  postgresCheckpointer,
} from "@b4run/postgres-storage"
import { dockerSandbox, kubernetesSandbox } from "@b4run/sandbox"
import {
  allow,
  deny,
  isB4Agent,
  type MiddlewareRequest,
  permit,
  reject,
  type ThreadAccessRequest,
} from "@b4run/sdk"
import { describe, expect, it } from "vitest"
import { contrast } from "../../../../lib/design-system-checks"
import { COLOR } from "../../../../lib/design-tokens"
import { DOCS_INDEX } from "../../docs/search-index"
import { CHECKLIST_FIXTURES, checklist, describeToggle } from "./checklist"
import sandboxConfig from "./fixtures/b4.config.sandbox"
import support from "./fixtures/src/app/support/index"
import middleware from "./fixtures/src/middleware"
import threadAccess from "./fixtures/src/thread-access"

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url))
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8")
const itemOf = (id: string) => {
  const item = checklist.find((candidate) => candidate.id === id)
  if (!item) throw new Error(`No checklist item ${id}`)
  return item
}

describe("the checklist shows real code", () => {
  it("has twelve items, each with a docs link and one or two sentences", () => {
    expect(checklist).toHaveLength(12)
    expect(new Set(checklist.map((item) => item.id)).size).toBe(12)
    for (const item of checklist) {
      for (const text of [item.title, item.chore, item.handledBy, item.code]) {
        expect(text, item.id).not.toContain("—")
      }
      expect(item.handledBy.match(/[.!?](?=\s|$)/g)?.length, item.id).toBeLessThanOrEqual(2)
      expect(item.chore, item.id).toMatch(/\.$/)
    }
  })

  it("takes every excerpt from its file, line for line", () => {
    for (const item of checklist) {
      const source = read(item.origin)
      const lines = source.split("\n").map((line) => line.trim())
      for (const line of item.code.split("\n")) {
        if (item.origin.endsWith(".mdx")) expect(source, item.id).toContain(line)
        else expect(lines, `${item.id}: ${line}`).toContain(line.trim())
      }
    }
  })

  it("reads a tool's schema from its types and doc comment, as b4 typegen does", async () => {
    const [greet, ...rest] = await extractToolSchemasForRoute({
      routeDir: resolve(repoRoot, "packages/devkit/templates/app-basic/src/app/hello"),
      sharedToolsDir: undefined,
      tsconfig: resolve(repoRoot, "packages/config-typescript/node.json"),
    })
    expect(rest).toEqual([])
    expect(greet?.name).toBe("greet")
    expect(greet?.description).toBe("Greet someone by name.")
    expect(greet?.parameters).toMatchObject({ required: ["name"], additionalProperties: false })
  }, 60_000)

  it("takes code only from files a typecheck compiles", () => {
    const template = "packages/devkit/templates/app-basic/"
    // The generated app's tsconfig compiles src/, and not test/.
    const include: string[] = JSON.parse(read(`${template}tsconfig.json.template`)).include
    expect(include).toContain("src/**/*.ts")
    expect(include.some((glob) => glob.startsWith("test"))).toBe(false)
    for (const item of checklist) {
      if (item.origin.endsWith(".mdx")) continue
      expect(
        [
          CHECKLIST_FIXTURES,
          "apps/web/app/components/homepage/tour/fixtures/",
          `${template}src/`,
        ].some((root) => item.origin.startsWith(root)),
        item.id,
      ).toBe(true)
    }
    // The offline-tests line is the eval's, and the scaffolded test has it too.
    const tests = itemOf("tests")
    expect(tests.origin).toBe(`${template}src/app/hello/evals/smoke.eval.ts.template`)
    expect(read(`${template}test/agent.test.ts.template`)).toContain(tests.code)
  })

  it("streams on the endpoints the runtime serves", () => {
    const runtime = read("packages/cli/src/lib/dev/runtime-fetch-core.ts")
    expect(runtime).toContain(
      String.raw`method: "POST",
      pattern: /^\/threads\/(?<thread_id>[^/?#]+)\/runs\/stream(?:\?.*)?$/,`,
    )
    expect(runtime).toContain(
      String.raw`method: "POST",
      pattern: /^\/agui\/(?<routeId>[^/?#]+)(?:\?.*)?$/,`,
    )
  })

  it("retries a failed model call only before anything has streamed", () => {
    const retry = read("packages/langchain/src/retry.ts")
    const classify = retry.slice(
      retry.indexOf("export function isRetryableError"),
      retry.indexOf("export async function withRetry"),
    )
    for (const needle of ["429", "rate limit", "503", "econnreset"]) {
      expect(classify).toContain(`message.includes("${needle}")`)
    }
    const adapter = read("packages/langchain/src/agent-adapter.ts")
    expect(adapter).toContain("retryConfig?.maxAttempts ?? 3")
    expect(adapter).toContain(
      "if (hasYielded || !isRetryableError(error) || attempt === maxStreamAttempts - 1) {",
    )
    // The streaming path's backoff is fixed, so the excerpt sets no baseDelay.
    expect(adapter).toContain("const delay = Math.min(1000 * 2 ** attempt")
    const retries = itemOf("retries")
    expect(retries.code).not.toContain("baseDelay")
    expect(read(`${CHECKLIST_FIXTURES}src/app/support/index.ts`)).not.toContain("baseDelay")
    expect(retries.handledBy).toContain("before anything has streamed")
  })

  it("moves the three durable stores to Postgres, which the defaults keep on local disk", () => {
    for (const store of [
      postgresCheckpointer,
      createPostgresThreadsStore,
      createPostgresPermissionsStore,
    ]) {
      expect(typeof store).toBe("function")
    }
    expect(itemOf("persistence").handledBy).toContain(
      "the checkpointer, the thread store and the permission store",
    )
    // The defaults already survive a restart, so the chore is sharing them.
    expect(itemOf("persistence").chore).not.toMatch(/restart/)
    const docs = read("apps/web/content/docs/persistence.mdx")
    expect(docs).toContain("**Default:** `.b4/checkpoints.sqlite`")
    expect(docs).toContain("**Default:** `.b4/threads.sqlite`")
    expect(docs).toContain(
      "When compute becomes ephemeral, or several processes need the same records, move the three durable runtime stores.",
    )
  })

  it("gives a route with memory.ts remember and recall tools", () => {
    const typegen = read("packages/cli/src/lib/typegen/run-typegen.ts")
    const extra = typegen.slice(typegen.indexOf("function memoryExtraTools"))
    const core = read("packages/core/src/capabilities/built-in/memory.ts")
    for (const tool of ["remember", "recall"]) {
      expect(extra).toContain(`name: "${tool}",`)
      expect(core).toContain(`name: "${tool}",`)
    }
    expect(itemOf("memory").handledBy).toContain("remember and recall tools")
  })

  it("turns away a request the middleware rejects, and lets the rest through", async () => {
    const request = (headers: Record<string, string>) =>
      ({ headers, params: {}, routeId: "/support", method: "POST" }) as unknown as MiddlewareRequest
    if (typeof middleware !== "function") throw new Error("The fixture is a handler function")
    await expect(middleware(request({}))).resolves.toEqual(
      reject(401, { error: "Missing x-api-key" }),
    )
    await expect(middleware(request({ "x-api-key": "k" }))).resolves.toEqual(allow())
  })

  it("stamps a thread's owner, and lets only that owner back in", async () => {
    const request = (headers: Record<string, string>, ownerId?: string) =>
      ({
        action: "read",
        headers,
        thread: ownerId === undefined ? undefined : { access: { ownerId } },
      }) as unknown as ThreadAccessRequest
    await expect(threadAccess.create?.(request({ "x-user-id": "ada" }))).resolves.toEqual(
      permit({ ownerId: "ada" }),
    )
    await expect(threadAccess.create?.(request({}))).resolves.toEqual(deny())
    await expect(threadAccess.fallback(request({ "x-user-id": "ada" }, "ada"))).resolves.toEqual(
      permit(),
    )
    await expect(threadAccess.fallback(request({ "x-user-id": "bob" }, "ada"))).resolves.toEqual(
      deny(),
    )
    await expect(threadAccess.fallback(request({ "x-user-id": "ada" }))).resolves.toEqual(deny())
  })

  it("names exactly the three approval decisions", () => {
    const decisions = ["once", "always", "deny"] as const satisfies readonly PermissionDecision[]
    const exhaustive: [Exclude<PermissionDecision, (typeof decisions)[number]>] extends [never]
      ? true
      : false = true
    expect(exhaustive).toBe(true)
    expect(itemOf("approval").handledBy).toContain(
      decisions.join(", ").replace(", deny", " or deny"),
    )
    expect(isB4Agent(support)).toBe(true)
  })

  it("configures a real sandbox provider, and names a real Kubernetes one", () => {
    expect(typeof dockerSandbox).toBe("function")
    expect(typeof kubernetesSandbox).toBe("function")
    expect(typeof sandboxConfig.sandbox?.provider.acquire).toBe("function")
    expect(itemOf("sandbox").handledBy).toContain("kubernetesSandbox")
  })

  it("names only commands and flags the b4 CLI has", () => {
    const program = createProgram({ stdout: () => undefined, stderr: () => undefined })
    const command = (name: string) => program.commands.find((entry) => entry.name() === name)
    expect(command("typegen")).toBeDefined()
    expect(command("inspect")).toBeDefined()
    expect(command("eval")?.options.map((option) => option.long)).toContain("--record")
    expect(itemOf("evals").handledBy).toContain("b4 eval --record")
    expect(itemOf("schemas").handledBy).toContain("b4 typegen")
    expect(itemOf("inspect").code).toBe("b4 inspect")
    // The basic scaffold installs the Inspector, so b4 inspect works in it.
    expect(
      JSON.parse(read("packages/devkit/templates/app-basic/package.json.template")).devDependencies,
    ).toHaveProperty("@b4run/inspector")
  })

  it("announces each turn with the new count, and Handled. at twelve", () => {
    const [first] = checklist
    if (!first) throw new Error("No items")
    expect(describeToggle(first, true, 1)).toBe(
      "Tool schemas: b4 typegen reads the tool's TypeScript types and its doc comment. 1 of 12 opened.",
    )
    expect(describeToggle(first, false, 0)).toBe("Tool schemas closed. 0 of 12 opened.")
    expect(describeToggle(first, true, 12)).toMatch(/12 of 12 opened\. Handled\.$/)
  })

  it("links to docs headings that exist", () => {
    for (const item of checklist) {
      const [path, anchor] = item.docsHref.split("#")
      const page = DOCS_INDEX.find((entry) => entry.href === path)
      expect(page, item.docsHref).toBeDefined()
      expect(
        page?.headings.map((heading) => heading.anchor),
        item.docsHref,
      ).toContain(anchor)
    }
  })

  it("keeps tile text at 4.5:1 or more on paper and on the opened tint", () => {
    for (const background of [COLOR.page, COLOR["relay-tint"]]) {
      for (const foreground of [COLOR.ink, COLOR["ink-muted"], COLOR["relay-ink"]]) {
        expect(
          contrast(foreground, background),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
