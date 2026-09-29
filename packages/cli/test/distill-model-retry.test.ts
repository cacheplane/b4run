import { mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { type MemoryRecord, sqliteMemoryStore } from "@b4run/memory"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

import { runMemoryCommand } from "../src/commands/memory.js"

/**
 * `b4 memory consolidate` / `reflect` build their chat model with
 * `maxRetries = memory.distill.retry.maxAttempts - 1` (default 3 attempts →
 * 2), not LangChain's 6, and refuse a malformed `retry` before building any
 * model. `@langchain/openai` is mocked, so no network and no API key.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const scratchRoot = resolve(repoRoot, "packages", "cli", ".tmp-distill-retry-apps")

let constructedWith: Record<string, unknown>[] = []

class FakeChatOpenAI {
  constructor(options: Record<string, unknown>) {
    constructedWith.push(options)
  }
  async invoke(prompt: unknown): Promise<{ content: string }> {
    return String(JSON.stringify(prompt)).includes("deriving durable insights")
      ? { content: '{"insights":[]}' }
      : { content: '{"summary":"five billing deploys"}' }
  }
}

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  vi.doUnmock("@langchain/openai")
  constructedWith = []
})

// Each app dir is removed after its test; drop the shared parent too.
// `rmdir` removes only an empty directory, so a concurrent run's apps survive.
afterAll(() => rmdir(scratchRoot).catch(() => {}))

async function makeApp(distillRetry?: string): Promise<string> {
  await mkdir(scratchRoot, { recursive: true })
  const root = await mkdtemp(join(scratchRoot, "app-"))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  await writeFile(join(root, "package.json"), '{ "name": "distill-retry-app", "type": "module" }\n')
  await writeFile(
    join(root, "b4.config.ts"),
    [
      "export default {",
      "  memory: {",
      "    distill: {",
      "      consolidate: { olderThanMs: 0, minBatchSize: 2, maxBatchSize: 50 },",
      "      reflect: { minNewRecords: 2, maxRecords: 100 },",
      ...(distillRetry === undefined ? [] : [`      retry: ${distillRetry},`]),
      "    },",
      "  },",
      "}",
      "",
    ].join("\n"),
  )
  const store = sqliteMemoryStore({ path: join(root, ".b4/memory.sqlite") })
  for (const day of [6, 7, 8]) {
    const at = `2026-07-0${day}T09:00:00.000Z`
    const record: MemoryRecord = {
      id: `e${day}`,
      kind: "episodic",
      namespace: "ws=app|route=/chat",
      content: `run e${day}: deployed the billing service`,
      data: {},
      source: { type: "run", id: `e${day}` },
      confidence: 1,
      tags: [],
      status: "active",
      createdAt: at,
      updatedAt: at,
      effectiveAt: at,
    }
    await store.put(record)
  }
  return root
}

describe("distillation model retry", () => {
  it.each(["consolidate", "reflect"])(
    "%s builds its model with maxRetries 2",
    async (command) => {
      vi.doMock("@langchain/openai", () => ({ ChatOpenAI: FakeChatOpenAI }))
      const appRoot = await makeApp()
      const err: string[] = []
      await runMemoryCommand(
        [command],
        { cwd: appRoot },
        { stdout: () => {}, stderr: (m) => err.push(m) },
      )
      expect(err.join("")).toBe("")
      expect(constructedWith).toHaveLength(1)
      expect(constructedWith[0]?.maxRetries).toBe(2)
    },
    60_000,
  )

  it.each(["consolidate", "reflect"])(
    "%s uses memory.distill.retry.maxAttempts",
    async (command) => {
      vi.doMock("@langchain/openai", () => ({ ChatOpenAI: FakeChatOpenAI }))
      const appRoot = await makeApp("{ maxAttempts: 5 }")
      await runMemoryCommand([command], { cwd: appRoot }, { stdout: () => {}, stderr: () => {} })
      expect(constructedWith.map((options) => options.maxRetries)).toEqual([4])
    },
    60_000,
  )

  it.each([
    ["consolidate", "{ maxAttempts: 0 }", /maxAttempts must be a whole number of at least 1/],
    ["reflect", "{ baseDelay: 500 }", /baseDelay isn't supported/],
    ["consolidate --dry-run", "{ maxattempts: 5 }", /Unknown memory\.distill\.retry option/],
  ])(
    "%s refuses retry %s before building a model",
    async (command, retry, message) => {
      vi.doMock("@langchain/openai", () => ({ ChatOpenAI: FakeChatOpenAI }))
      const appRoot = await makeApp(retry)
      const error = await runMemoryCommand(
        command.split(" "),
        { cwd: appRoot },
        { stdout: () => {}, stderr: () => {} },
      ).catch((caught: unknown) => caught)
      expect(error).toMatchObject({ code: "B4_E1009" })
      expect(String((error as Error).message)).toMatch(message)
      expect(constructedWith).toEqual([])
    },
    60_000,
  )
})
