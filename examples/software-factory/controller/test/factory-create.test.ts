import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/lib/controller/factory.ts"
import type { IssueOrigin } from "../src/lib/domain/work-order.ts"
import { issueText } from "../src/lib/intake/issue.ts"
import {
  configureCatalog,
  loadTask,
  loadTaskIds,
  resetCatalogForTests,
} from "../src/lib/targets/catalog.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { fakeBuilderHandoff, fakeWorkerMap } from "./fake-worker-map.ts"
import { createFakeWorkspaceReader } from "./fake-workspace-reader.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

let dir: string
let generatedTasksDir: string
let fake: FakeWorker
let factory: Factory

async function boot() {
  dir = mkdtempSync(join(tmpdir(), "factory-create-"))
  generatedTasksDir = join(dir, "state", "tasks")
  configureCatalog({ generatedTasksDir })
  fake = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    generatedTasksDir,
    captureRoot: dir,
    workers: fakeWorkerMap({
      builder: {
        client: createHttpWorkerClient(fake.baseUrl, { token: TEST_WORKER_TOKEN }),
        reader: createFakeWorkspaceReader({}),
      },
    }),
    captureBuilderHandoff: fakeBuilderHandoff,
    exportDir: join(dir, "out"),
    artifactsDir: join(dir, "artifacts"),
    verifier: createFakeVerifier({ verdict: "pass" }),
    captureBaseline: async () => ({ digest: "a".repeat(64), files: new Map() }),
  })
}
afterEach(async () => {
  resetCatalogForTests()
  await factory?.close()
  await fake?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const ORIGIN: IssueOrigin = {
  kind: "issue",
  repository: "cacheplane/b4run",
  number: 778,
  bodyDigest: "0".repeat(64),
}
const PIN = "a".repeat(40)
const ISSUE = { title: "T", body: "B" }
const KEY = "issue:cacheplane/b4run#778"

describe("createFromIssue", () => {
  it("records the origin, the pin and the issue text, and nothing the catalog can list", async () => {
    await boot()
    const row = await factory.createFromIssue({
      origin: ORIGIN,
      pin: PIN,
      issue: ISSUE,
      operationKey: KEY,
    })
    expect(row).toMatchObject({
      state: "received",
      origin: ORIGIN,
      pin: PIN,
      taskId: row.id,
      targetId: null,
      taskDigest: null,
      intakeAttempts: 0,
      revision: 0,
    })
    expect(row.id).toMatch(/^wo-[a-f0-9]{16}$/)
    expect(factory.show(row.id)).toEqual(row)
    expect(factory.events(row.id).map((e) => [e.type, e.payload])).toEqual([
      ["created", { origin: ORIGIN, pin: PIN }],
    ])
    const text = readFileSync(join(generatedTasksDir, row.id, "issue.md"), "utf8")
    expect(text).toBe(issueText({ ...ISSUE, repository: ORIGIN.repository, number: ORIGIN.number }))
    expect(readdirSync(join(generatedTasksDir, row.id))).toEqual(["issue.md"])
    // An issue-only directory is not a task yet: the catalog lists and loads only task.json.
    expect(loadTaskIds()).not.toContain(row.id)
    expect(() => loadTask(row.id)).toThrow(/Unknown task/)
  })

  it("is idempotent by operation key and writes issue.md once", async () => {
    await boot()
    const first = await factory.createFromIssue({
      origin: ORIGIN,
      pin: PIN,
      issue: ISSUE,
      operationKey: KEY,
    })
    const written = statSync(join(generatedTasksDir, first.id, "issue.md")).mtimeMs
    const again = await factory.createFromIssue({
      origin: ORIGIN,
      pin: PIN,
      issue: { title: "changed", body: "changed" },
      operationKey: KEY,
    })
    expect(again).toEqual(first)
    expect(factory.list()).toHaveLength(1)
    expect(factory.events(first.id)).toHaveLength(1)
    expect(statSync(join(generatedTasksDir, first.id, "issue.md")).mtimeMs).toBe(written)
    expect(readFileSync(join(generatedTasksDir, first.id, "issue.md"), "utf8")).toContain("# T ")
  })

  it("names a fresh work order without a key", async () => {
    await boot()
    const a = await factory.createFromIssue({ origin: ORIGIN, pin: PIN, issue: ISSUE })
    const b = await factory.createFromIssue({ origin: ORIGIN, pin: PIN, issue: ISSUE })
    expect(a.id).not.toBe(b.id)
    expect(existsSync(join(generatedTasksDir, a.id, "issue.md"))).toBe(true)
    expect(existsSync(join(generatedTasksDir, b.id, "issue.md"))).toBe(true)
  })

  it("refuses a bad pin or origin before spending the key", async () => {
    await boot()
    await expect(
      factory.createFromIssue({
        origin: ORIGIN,
        pin: "not-a-sha",
        issue: ISSUE,
        operationKey: KEY,
      }),
    ).rejects.toThrow(/pin/)
    await expect(
      factory.createFromIssue({
        origin: { ...ORIGIN, repository: "../x" },
        pin: PIN,
        issue: ISSUE,
        operationKey: KEY,
      }),
    ).rejects.toThrow(/origin\.repository/)
    expect(factory.list()).toEqual([])
    // The key was never spent: the same key with a good pin creates, rather than being refused
    // as a command still in flight.
    const row = await factory.createFromIssue({
      origin: ORIGIN,
      pin: PIN,
      issue: ISSUE,
      operationKey: KEY,
    })
    expect(row).toMatchObject({ state: "received", pin: PIN })
    expect(existsSync(join(generatedTasksDir, row.id, "issue.md"))).toBe(true)
  })

  it("keeps the catalog create's journal shape", async () => {
    await boot()
    const row = await factory.create({ taskId: "cli-flags" })
    expect(row).toMatchObject({ origin: { kind: "catalog" }, pin: null, taskId: "cli-flags" })
    expect(factory.events(row.id).map((e) => e.payload)).toEqual([{ taskId: "cli-flags" }])
    expect(existsSync(join(generatedTasksDir, row.id))).toBe(false)
  })
})
