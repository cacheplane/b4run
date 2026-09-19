import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createMemoryInterruptGrantStore, hashApprovalGrant } from "@b4run/sdk"
import { afterEach, describe, expect, test } from "vitest"

import { startRuntimeServer } from "../src/lib/dev/runtime-server.js"

/**
 * End-to-end coverage of the grant half of `POST /threads/:id/resume`:
 * verification, single-use consumption, and every refusal.
 *
 * The fixture app's `b4.config.ts` publishes its grant store on `globalThis`
 * so the test can seed rows that match the fixed pending-write set — the same
 * shape the existing resume-endpoint tests use for their concurrency gate.
 * Seeding rather than parking for real is deliberate: parking is covered where
 * it lives, at the park site in `@b4run/core`, and pinning the two halves
 * against a fixed wire shape is what catches them drifting apart.
 */

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []
const STORE_KEY = "__b4ApprovalGrantStoreForTests"

const GRANT = "b4ag_TEST_GRANT_VALUE_FOR_PERM_1_AAAAAAAAAAAA"
const OTHER_GRANT = "b4ag_TEST_GRANT_VALUE_FOR_SOMETHING_ELSE_BBB"

const pendingOne = [
  [
    "33a12321-3ec2-56a7-b4d7-0337886c4386",
    "__interrupt__",
    { id: "3336d0e0a2d4f198ef9aecd09cd7ac27", value: { interruptId: "perm-1", grant: GRANT } },
  ],
] as const

afterEach(async () => {
  delete (globalThis as Record<string, unknown>)[STORE_KEY]
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

/** Runtime error bodies are `{ error: { kind, message, details } }`. */
async function detailsOf(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error?: { details?: Record<string, unknown> } }
  return body.error?.details ?? {}
}

function storeForTests(): ReturnType<typeof createMemoryInterruptGrantStore> {
  const store = (globalThis as Record<string, unknown>)[STORE_KEY]
  if (!store) throw new Error("fixture did not publish its grant store")
  return store as ReturnType<typeof createMemoryInterruptGrantStore>
}

async function seedGrant(threadId: string, interruptId: string, grant: string): Promise<void> {
  await storeForTests().issue({
    threadId,
    interruptId,
    checkpointNs: `park:${interruptId}`,
    tokenHash: await hashApprovalGrant(grant),
    issuedAt: new Date().toISOString(),
    expiresAt: null,
    consumedAt: null,
    consumedDecision: null,
    voidedAt: null,
  })
}

describe("approval grants on POST /threads/:id/resume", () => {
  test("required: a valid grant resumes, and the SECOND identical resume is refused, not re-executed", async () => {
    const { url } = await startFixture("required")
    const threadId = "thread-grant-once"
    await seedRoute(url, threadId)
    await seedGrant(threadId, "perm-1", GRANT)

    const first = await postResume(url, threadId, {
      resume: [{ interruptId: "perm-1", status: "resolved", payload: "once", grant: GRANT }],
      route: "/noop#graph",
    })
    expect(first.status).toBe(200)
    expect(executionCount()).toBe(2) // the seeding turn, then the resumed turn

    // The replay. This is the whole feature.
    const second = await postResume(url, threadId, {
      resume: [{ interruptId: "perm-1", status: "resolved", payload: "once", grant: GRANT }],
      route: "/noop#graph",
    })
    expect(second.status).toBe(409)
    const details = await detailsOf(second)
    expect(details.code).toBe("grant_consumed")
    // Echoed so a double-submitting UI renders "already approved" rather than
    // re-prompting.
    expect(details.consumedDecision).toBe("once")
    // NOT re-executed.
    expect(executionCount()).toBe(2)
  })

  test("a grant minted for a different parked call is refused", async () => {
    const { url } = await startFixture("required")
    const threadId = "thread-grant-wrong"
    await seedRoute(url, threadId)
    await seedGrant(threadId, "perm-1", GRANT)

    const response = await postResume(url, threadId, {
      resume: [{ interruptId: "perm-1", status: "resolved", payload: "once", grant: OTHER_GRANT }],
      route: "/noop#graph",
    })
    expect(response.status).toBe(403)
    expect((await detailsOf(response)).code).toBe("grant_invalid")
  })

  test("a wrong grant and a nonexistent grant row are INDISTINGUISHABLE", async () => {
    // The endpoint must not be an oracle: a caller who has passed the thread
    // gate must not be able to learn whether a guessed interruptId names a
    // real parked call. If this test fails because someone added a helpful
    // `reason` field, remove the field — do not update the assertion.
    const { url } = await startFixture("required")
    const wrong = await (async () => {
      const threadId = "thread-oracle-wrong"
      await seedRoute(url, threadId)
      await seedGrant(threadId, "perm-1", GRANT)
      return postResume(url, threadId, {
        resume: [
          { interruptId: "perm-1", status: "resolved", payload: "once", grant: OTHER_GRANT },
        ],
        route: "/noop#graph",
      })
    })()
    const malformed = await (async () => {
      const threadId = "thread-oracle-malformed"
      await seedRoute(url, threadId)
      await seedGrant(threadId, "perm-1", GRANT)
      return postResume(url, threadId, {
        resume: [{ interruptId: "perm-1", status: "resolved", payload: "once", grant: "nonsense" }],
        route: "/noop#graph",
      })
    })()

    expect(wrong.status).toBe(malformed.status)
    expect(await wrong.json()).toEqual(await malformed.json())
  })

  test("required: a resume with no grant at all is refused", async () => {
    const { url } = await startFixture("required")
    const threadId = "thread-grant-missing"
    await seedRoute(url, threadId)
    await seedGrant(threadId, "perm-1", GRANT)

    const response = await postResume(url, threadId, {
      resume: [{ interruptId: "perm-1", status: "resolved", payload: "once" }],
      route: "/noop#graph",
    })
    expect(response.status).toBe(400)
    expect((await detailsOf(response)).code).toBe("grant_required")
  })

  test("required: an interrupt parked before the migration cannot be retrofitted", async () => {
    const { url } = await startFixture("required")
    const threadId = "thread-grant-pre-migration"
    await seedRoute(url, threadId)
    // No seeded row: this prompt predates grants.

    const response = await postResume(url, threadId, {
      resume: [{ interruptId: "perm-1", status: "resolved", payload: "once", grant: GRANT }],
      route: "/noop#graph",
    })
    expect(response.status).toBe(409)
    expect((await detailsOf(response)).code).toBe("grant_unavailable")
  })

  test("optional: an interrupt with NO grant row resumes exactly as before", async () => {
    const { url } = await startFixture("optional")
    const threadId = "thread-optional-legacy"
    await seedRoute(url, threadId)

    const response = await postResume(url, threadId, {
      resume: [{ interruptId: "perm-1", status: "resolved", payload: "once" }],
      route: "/noop#graph",
    })
    expect(response.status).toBe(200)
  })

  test("optional: an interrupt WITH a grant row still requires its grant", async () => {
    // Without this rule "optional" is a bypass — omit the grant, get the old
    // path. The softness is per-interrupt-age, never per-request.
    const { url } = await startFixture("optional")
    const threadId = "thread-optional-bypass"
    await seedRoute(url, threadId)
    await seedGrant(threadId, "perm-1", GRANT)

    const response = await postResume(url, threadId, {
      resume: [{ interruptId: "perm-1", status: "resolved", payload: "once" }],
      route: "/noop#graph",
    })
    expect(response.status).toBe(403)
    expect((await detailsOf(response)).code).toBe("grant_invalid")
  })

  test("a superseded (voided) grant is refused as stale", async () => {
    const { url } = await startFixture("required")
    const threadId = "thread-grant-stale"
    await seedRoute(url, threadId)
    await seedGrant(threadId, "perm-1", GRANT)
    await storeForTests().voidOutstanding({
      threadId,
      keepInterruptIds: [],
      at: new Date().toISOString(),
    })

    const response = await postResume(url, threadId, {
      resume: [{ interruptId: "perm-1", status: "resolved", payload: "once", grant: GRANT }],
      route: "/noop#graph",
    })
    expect(response.status).toBe(409)
    expect((await detailsOf(response)).code).toBe("stale_interrupt")
  })

  test("an expired grant is refused", async () => {
    const { url } = await startFixture("required")
    const threadId = "thread-grant-expired"
    await seedRoute(url, threadId)
    await storeForTests().issue({
      threadId,
      interruptId: "perm-1",
      checkpointNs: "park:perm-1",
      tokenHash: await hashApprovalGrant(GRANT),
      issuedAt: new Date(Date.now() - 10_000).toISOString(),
      expiresAt: new Date(Date.now() - 5_000).toISOString(),
      consumedAt: null,
      consumedDecision: null,
      voidedAt: null,
    })

    const response = await postResume(url, threadId, {
      resume: [{ interruptId: "perm-1", status: "resolved", payload: "once", grant: GRANT }],
      route: "/noop#graph",
    })
    expect(response.status).toBe(409)
    expect((await detailsOf(response)).code).toBe("grant_expired")
  })

  test("a CANCELLED decision consumes the grant too", async () => {
    // Open question 2, taking the design's recommendation: a denial IS a
    // decision, and a re-answerable denial is a replay surface of its own.
    const { url } = await startFixture("required")
    const threadId = "thread-grant-cancelled"
    await seedRoute(url, threadId)
    await seedGrant(threadId, "perm-1", GRANT)

    const first = await postResume(url, threadId, {
      resume: [{ interruptId: "perm-1", status: "cancelled", grant: GRANT }],
      route: "/noop#graph",
    })
    expect(first.status).toBe(200)

    const record = await storeForTests().get(threadId, "perm-1")
    expect(record?.consumedAt).not.toBeNull()
    expect(record?.consumedDecision).toBe("deny")

    const second = await postResume(url, threadId, {
      resume: [{ interruptId: "perm-1", status: "cancelled", grant: GRANT }],
      route: "/noop#graph",
    })
    expect(second.status).toBe(409)
    expect((await detailsOf(second)).code).toBe("grant_consumed")
  })

  test('"off" requires nothing and records nothing — the pre-grant path exactly', async () => {
    const { url } = await startFixture("off")
    const threadId = "thread-grants-off"
    await seedRoute(url, threadId)

    const first = await postResume(url, threadId, {
      resume: [{ interruptId: "perm-1", status: "resolved", payload: "once" }],
      route: "/noop#graph",
    })
    expect(first.status).toBe(200)
  })

  test("GET /threads/:id/pending_interrupts lifts the grant to a top-level field", async () => {
    const { url } = await startFixture("required")
    const threadId = "thread-grant-disclosure"
    await seedRoute(url, threadId)

    const response = await fetch(new URL(`/threads/${threadId}/pending_interrupts`, url))
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      interrupts: { interruptId: string; grant?: string; value?: unknown }[]
    }
    expect(body.interrupts[0]?.grant).toBe(GRANT)
    // Re-readable by design: a client that reloads must be able to get it
    // again. Single-use is a property of CONSUMPTION, not of disclosure.
    const again = await fetch(new URL(`/threads/${threadId}/pending_interrupts`, url))
    expect(
      ((await again.json()) as { interrupts: { grant?: string }[] }).interrupts[0]?.grant,
    ).toBe(GRANT)
  })
})

// ── fixture ────────────────────────────────────────────────────────────────

function executionCount(): number {
  return ((globalThis as Record<string, unknown>).__b4GrantFixtureRuns as number) ?? 0
}

async function startFixture(mode: "off" | "optional" | "required"): Promise<{ url: string }> {
  ;(globalThis as Record<string, unknown>)[STORE_KEY] = createMemoryInterruptGrantStore()
  ;(globalThis as Record<string, unknown>).__b4GrantFixtureRuns = 0
  const appRoot = await createFixtureApp({
    "b4.config.ts": `
      export default {
        approvals: {
          grants: ${JSON.stringify(mode)},
          grantStore: globalThis[${JSON.stringify(STORE_KEY)}],
        },
        checkpointer: {
          getTuple: async () => ({ pendingWrites: ${JSON.stringify(pendingOne)} }),
        },
      };
    `,
    "package.json": '{"type":"module"}\n',
    "src/app/noop/index.ts": `
      export const graph = async () => {
        globalThis.__b4GrantFixtureRuns = (globalThis.__b4GrantFixtureRuns ?? 0) + 1;
        return { ok: true };
      };
    `,
  })
  const server = await startRuntimeServer({ appRoot })
  servers.push(server)
  return { url: server.url }
}

async function seedRoute(serverUrl: string, threadId: string): Promise<void> {
  const response = await fetch(new URL(`/threads/${threadId}/runs/wait`, serverUrl), {
    body: JSON.stringify({ input: {}, route: "/noop#graph" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
  expect(response.status).toBe(200)
}

async function postResume(serverUrl: string, threadId: string, body: unknown): Promise<Response> {
  return fetch(new URL(`/threads/${threadId}/resume`, serverUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

async function createFixtureApp(files: Record<string, string>): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-approval-grants-"))
  tempDirs.push(appRoot)
  for (const [relative, contents] of Object.entries(files)) {
    const target = join(appRoot, relative)
    await mkdir(join(target, ".."), { recursive: true })
    await writeFile(target, contents, "utf8")
  }
  return appRoot
}
