import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  createMemoryInterruptGrantStore,
  type InterruptGrantRecord,
  type InterruptGrantStore,
} from "@b4run/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAimock } from "../../testing/dist/aimock-runner.js"
import {
  __resetApprovalGrantPruneThrottleForTests,
  APPROVAL_GRANT_PRUNE_INTERVAL_MS,
  ApprovalGrantConfigError,
  DEFAULT_APPROVAL_GRANT_RETENTION_MS,
  pruneSettledGrants,
  resolveApprovalGrantRetentionMs,
  validateInterruptGrantStore,
  voidSupersededGrants,
} from "../src/lib/dev/approval-grants.ts"
import { MAX_CLIENT_TOOL_TTL_MS } from "../src/lib/dev/client-tool-runtime.ts"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.ts"

describe("approval grant retention settings", () => {
  it("grantRetentionMs defaults to 7 days, and a mistyped value fails the boot", () => {
    expect(resolveApprovalGrantRetentionMs(undefined)).toBe(DEFAULT_APPROVAL_GRANT_RETENTION_MS)
    expect(DEFAULT_APPROVAL_GRANT_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000)
    expect(resolveApprovalGrantRetentionMs(1)).toBe(1)
    expect(resolveApprovalGrantRetentionMs(MAX_CLIENT_TOOL_TTL_MS)).toBe(MAX_CLIENT_TOOL_TTL_MS)
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "604800000", null]) {
      expect(() => resolveApprovalGrantRetentionMs(bad)).toThrow(ApprovalGrantConfigError)
    }
    expect(() => resolveApprovalGrantRetentionMs(MAX_CLIENT_TOOL_TTL_MS + 1)).toThrow(
      /approvals\.grantRetentionMs/,
    )
  })

  it("a configured grantStore must implement every method, prune included", () => {
    expect(validateInterruptGrantStore(undefined)).toBeUndefined()
    const store = createMemoryInterruptGrantStore()
    expect(validateInterruptGrantStore(store)).toBe(store)
    const { prune: _omitted, ...withoutPrune } = store
    expect(() => validateInterruptGrantStore(withoutPrune)).toThrow(/missing prune/)
    expect(() => validateInterruptGrantStore({ issue() {} })).toThrow(ApprovalGrantConfigError)
    expect(() => validateInterruptGrantStore("sqlite")).toThrow(/approvals\.grantStore/)
  })
})

describe("pruneSettledGrants (opportunistic sweep)", () => {
  const row = (over: Partial<InterruptGrantRecord>): InterruptGrantRecord => ({
    threadId: "t-sweep",
    interruptId: "i",
    checkpointNs: "",
    tokenHash: "0".repeat(64),
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: null,
    consumedAt: null,
    consumedDecision: null,
    voidedAt: null,
    ...over,
  })
  afterEach(() => __resetApprovalGrantPruneThrottleForTests())

  it("deletes settled rows older than the window and keeps outstanding ones, expired or not", async () => {
    const store = createMemoryInterruptGrantStore()
    await store.issue(row({ interruptId: "old", voidedAt: "2026-10-01T00:00:00.000Z" }))
    await store.issue(row({ interruptId: "expired", expiresAt: "2026-10-01T00:01:00.000Z" }))
    await store.issue(row({ interruptId: "live" }))
    const now = new Date("2026-10-01T12:00:00.000Z")
    expect(await pruneSettledGrants(store, 3_600_000, now)).toBe(1)
    expect((await store.listForThread("t-sweep")).map((r) => r.interruptId).sort()).toEqual([
      "expired",
      "live",
    ])
  })

  it("runs at most once per interval per store", async () => {
    const store = createMemoryInterruptGrantStore()
    let calls = 0
    const counting: InterruptGrantStore = {
      ...store,
      prune: async (options) => {
        calls += 1
        return store.prune(options)
      },
    }
    const t0 = new Date("2026-10-01T12:00:00.000Z")
    expect(await pruneSettledGrants(counting, 3_600_000, t0)).toBe(0)
    expect(
      await pruneSettledGrants(
        counting,
        3_600_000,
        new Date(t0.getTime() + APPROVAL_GRANT_PRUNE_INTERVAL_MS - 1),
      ),
    ).toBeUndefined()
    expect(
      await pruneSettledGrants(
        counting,
        3_600_000,
        new Date(t0.getTime() + APPROVAL_GRANT_PRUNE_INTERVAL_MS),
      ),
    ).toBe(0)
    expect(calls).toBe(2)
  })

  it("never throws: a failing store is warned about once and reports undefined", async () => {
    const store = createMemoryInterruptGrantStore()
    const failing: InterruptGrantStore = {
      ...store,
      prune: async () => {
        throw new Error("disk full")
      },
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(pruneSettledGrants(failing, 3_600_000, new Date())).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("could not prune settled approval grants"),
        expect.any(Error),
      )
    } finally {
      warn.mockRestore()
    }
  })

  it("rides voidSupersededGrants: the void count is returned and the sweep runs after it", async () => {
    const store = createMemoryInterruptGrantStore()
    await store.issue(
      row({ threadId: "t-other", interruptId: "old", voidedAt: "2020-01-01T00:00:00.000Z" }),
    )
    await store.issue(row({ threadId: "t-now", interruptId: "pending" }))
    await store.issue(row({ threadId: "t-now", interruptId: "moved_past" }))
    const voided = await voidSupersededGrants({
      store,
      threadId: "t-now",
      stillPending: ["pending"],
      retentionMs: 3_600_000,
    })
    expect(voided).toBe(1)
    expect(await store.get("t-other", "old")).toBeUndefined()
    expect((await store.get("t-now", "moved_past"))?.voidedAt).not.toBeNull()
    expect((await store.get("t-now", "pending"))?.voidedAt).toBeNull()
  })

  it("sweeps even when the void itself failed", async () => {
    const store = createMemoryInterruptGrantStore()
    await store.issue(
      row({ threadId: "t-other", interruptId: "old", voidedAt: "2020-01-01T00:00:00.000Z" }),
    )
    const voidFails: InterruptGrantStore = {
      ...store,
      voidOutstanding: async () => {
        throw new Error("void failed")
      },
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const voided = await voidSupersededGrants({
        store: voidFails,
        threadId: "t-now",
        stillPending: [],
        retentionMs: 3_600_000,
      })
      expect(voided).toBe(0)
      expect(await store.get("t-other", "old")).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })
})

// ── boot ────────────────────────────────────────────────────────────────────
//
// The config key read by the real boot. The sweep hangs off
// `voidSupersededGrants`, which `settleParkedRoute` reaches only for an AGENT
// route that parked (or had a parked route recorded), so the fixture is the
// smallest thing that parks for real: an agent whose one tool needs approval,
// the model played by aimock, one AG-UI turn. The plain graph route the
// resume-endpoint tests boot never gets there (`canPark` is false for it).

const cleanup: Array<() => Promise<void> | void> = []
const STORE_KEY = "__b4ApprovalGrantPruneTestStore"

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  delete (globalThis as Record<string, unknown>)[STORE_KEY]
})

/** An agent route whose `deployProd` server tool needs human approval. */
const APPROVE_ROUTE = [
  'import { agent } from "@b4run/sdk"',
  'export default agent({ model: "gpt-5-mini", systemPrompt: "t", tools: { approve: ["deployProd"] } })',
  "",
].join("\n")

const DEPLOY_TOOL = [
  "/** Deploy to an environment. */",
  "export default async function deployProd(input: { env: string }): Promise<string> {",
  '  return "deployed to " + input.env',
  "}",
  "",
].join("\n")

async function fixtureApp(config: string): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-approval-grant-prune-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "b4.config.ts": config,
    "package.json": '{ "name": "approval-grant-prune-fixture", "type": "module" }\n',
    "src/app/deploy/index.ts": APPROVE_ROUTE,
    "src/app/deploy/tools/deployProd.ts": DEPLOY_TOOL,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

/** The model: on "hello" it calls `deployProd`, which parks for approval. */
async function withParkingModel(): Promise<void> {
  const aimock = await createAimock({ fixtures: [] })
  cleanup.push(() => aimock.close())
  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = prevKey ?? "test-not-used"
  cleanup.push(() => {
    if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prevBaseUrl
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
  })
  aimock.addFixtures([
    {
      match: { userMessage: "hello" },
      response: {
        toolCalls: [{ id: "call_deploy", name: "deployProd", arguments: { env: "p" } }],
      },
    },
  ] as never)
}

async function createHandler(appRoot: string) {
  const handler = await createRuntimeFetchHandler({
    appRoot,
    apSseHeartbeatIntervalMs: 60_000,
    drainDeadlineMs: 250,
  })
  cleanup.push(() => handler.close())
  return handler
}

function aguiRequest(threadId: string): Request {
  return new Request(`http://localhost/agui/${encodeURIComponent("/deploy#agent")}`, {
    body: JSON.stringify({
      context: [],
      forwardedProps: {},
      messages: [{ id: "m1", role: "user", content: "hello" }],
      runId: "run-1",
      state: {},
      threadId,
      tools: [],
    }),
    headers: { accept: "text/event-stream", "content-type": "application/json" },
    method: "POST",
  })
}

/**
 * Boot with `config`, seed a row on an unrelated thread voided two minutes
 * ago, run one turn that parks — reaching `voidSupersededGrants` — and report
 * whether the seeded row survived the sweep that rode it.
 */
async function sweptRowSurvives(approvals: string): Promise<boolean> {
  __resetApprovalGrantPruneThrottleForTests()
  const store = createMemoryInterruptGrantStore()
  ;(globalThis as Record<string, unknown>)[STORE_KEY] = store
  const voidedAt = new Date(Date.now() - 2 * 60_000).toISOString()
  await store.issue({
    threadId: "t-elsewhere",
    interruptId: "old",
    checkpointNs: "park:old",
    tokenHash: "0".repeat(64),
    issuedAt: voidedAt,
    expiresAt: null,
    consumedAt: null,
    consumedDecision: null,
    voidedAt,
  })
  await withParkingModel()
  const appRoot = await fixtureApp(`export default { approvals: ${approvals} }\n`)
  const handler = await createHandler(appRoot)
  const threadId = `thread-${crypto.randomUUID()}`
  const response = await handler.fetch(aguiRequest(threadId))
  const text = await response.text()
  expect(response.status).toBe(200)
  // The turn parked for approval, so the settle ran the void (and the sweep).
  expect(text).toContain("perm-")
  expect((await store.listForThread(threadId)).length).toBeGreaterThan(0)
  return (await store.get("t-elsewhere", "old")) !== undefined
}

describe("approvals.grantRetentionMs at boot", () => {
  it("a bad grantRetentionMs fails the boot", async () => {
    const appRoot = await fixtureApp(
      'export default { approvals: { grants: "optional", grantRetentionMs: 0 } }\n',
    )
    await expect(createHandler(appRoot)).rejects.toThrow(ApprovalGrantConfigError)
    await expect(createHandler(appRoot)).rejects.toThrow(/approvals\.grantRetentionMs/)
  })

  it("the boot-resolved grantRetentionMs, not the default, reaches the sweep", async () => {
    // Same row, same turn; only the config differs. Under the 7-day default a
    // row voided two minutes ago survives; under a 1ms retention it does not.
    expect(
      await sweptRowSurvives(`{ grants: "optional", grantStore: globalThis.${STORE_KEY} }`),
    ).toBe(true)
    for (const fn of cleanup.splice(0).reverse()) await fn()
    expect(
      await sweptRowSurvives(
        `{ grants: "optional", grantStore: globalThis.${STORE_KEY}, grantRetentionMs: 1 }`,
      ),
    ).toBe(false)
  })
})
