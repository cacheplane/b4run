import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { sqliteMemoryStore } from "@b4run/memory"
import { afterEach, describe, expect, it } from "vitest"

// ---------------------------------------------------------------------------
// Per-principal memory, end to end through the real memory capability: the
// harness (loaded from @b4run/testing's build, as episodic-recorder.test.ts
// does, to avoid a package cycle) drives an agent whose `memory.ts` declares
// a `user` dimension that `resolveScope` fills from the request principal.
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const scratchRoot = resolve(repoRoot, "packages", "cli", ".tmp-memory-principal-apps")
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

interface HarnessLike {
  run(opts: { input: string; fixtures?: unknown }): Promise<{
    readonly toolResults: ReadonlyArray<{ readonly name: string; readonly content: unknown }>
  }>
  close(): Promise<void>
}

interface TestingModule {
  createAgentHarness(opts: {
    appRoot: string
    route: string
    principal?: { readonly id: string }
  }): Promise<HarnessLike>
  script(): {
    user(text: string): ReturnType<TestingModule["script"]>
    callsTool(name: string, args: Record<string, unknown>): ReturnType<TestingModule["script"]>
    replies(content: string): ReturnType<TestingModule["script"]>
  }
}

async function loadTesting(): Promise<TestingModule> {
  const distEntry = join(repoRoot, "packages", "testing", "dist", "index.js")
  return (await import(pathToFileURL(distEntry).href)) as unknown as TestingModule
}

async function makeApp(): Promise<string> {
  await mkdir(scratchRoot, { recursive: true })
  const root = await mkdtemp(join(scratchRoot, "app-"))
  tempDirs.push(root)
  await writeFile(
    join(root, "package.json"),
    '{ "name": "memory-principal-app", "type": "module" }\n',
  )
  await writeFile(
    join(root, "b4.config.ts"),
    [
      "export default {",
      "  memory: {",
      '    writes: "auto",',
      "    resolveScope: ({ principal }) => (principal ? { user: principal.id } : {}),",
      "  },",
      "}",
      "",
    ].join("\n"),
  )
  const routeDir = join(root, "src", "app", "chat")
  await mkdir(routeDir, { recursive: true })
  await writeFile(
    join(routeDir, "index.ts"),
    [
      'import { agent } from "@b4run/sdk"',
      'export default agent({ model: "gpt-5-mini", systemPrompt: "Remember what the user says." })',
      "",
    ].join("\n"),
  )
  await mkdir(join(root, "node_modules"), { recursive: true })
  await symlink(
    join(repoRoot, "packages", "testing", "node_modules", "zod"),
    join(root, "node_modules", "zod"),
    "dir",
  )
  await writeFile(
    join(routeDir, "memory.ts"),
    [
      'import { defineMemory } from "@b4run/sdk"',
      'import { z } from "zod"',
      "export default defineMemory({",
      '  kind: "semantic",',
      '  scope: ["route", "user"],',
      "  schema: z.object({ note: z.string() }),",
      "})",
      "",
    ].join("\n"),
  )
  return root
}

const REMEMBER = { data: { note: "likes coffee" }, content: "Likes coffee." }

async function rememberAs(appRoot: string, principal?: { readonly id: string }) {
  const { createAgentHarness, script } = await loadTesting()
  const harness = await createAgentHarness({
    appRoot,
    route: "/chat#agent",
    ...(principal ? { principal } : {}),
  })
  try {
    return await harness.run({
      input: "I like coffee",
      fixtures: script().user("I like coffee").callsTool("remember", REMEMBER).replies("Noted."),
    })
  } finally {
    await harness.close()
  }
}

describe("memory scoped by the request principal", () => {
  it("writes each principal's memory into its own namespace", async () => {
    const appRoot = await makeApp()
    await rememberAs(appRoot, { id: "alice" })
    await rememberAs(appRoot, { id: "bob" })
    const store = sqliteMemoryStore({ path: join(appRoot, ".b4", "memory.sqlite") })
    // `namespace` is an exact match: each caller's own, and nothing shared.
    for (const user of ["alice", "bob"]) {
      const own = await store.search({ namespace: `route=/chat|user=${user}`, status: "active" })
      expect(own.map((record) => record.content)).toEqual(["Likes coffee."])
    }
    expect(await store.search({ namespace: "route=/chat" })).toEqual([])
  }, 60_000)

  it("refuses memory to an anonymous caller instead of using the shared namespace", async () => {
    const appRoot = await makeApp()
    const run = await rememberAs(appRoot)
    const remembered = run.toolResults.find((result) => result.name === "remember")
    expect(String(remembered?.content)).toMatch(/memory is unavailable/i)
    const store = sqliteMemoryStore({ path: join(appRoot, ".b4", "memory.sqlite") })
    // Neither the shared namespace nor the unscoped sentinel received anything.
    expect(await store.search({ namespace: "route=/chat" })).toEqual([])
    expect(await store.search({ namespace: "b4:unscoped" })).toEqual([])
  }, 60_000)
})
