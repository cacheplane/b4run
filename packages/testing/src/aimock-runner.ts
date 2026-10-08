import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { getTextContent, LLMock } from "@copilotkit/aimock"
import type { AimockFixture, AimockResponse } from "./fixture-builder.js"
import type { Recording } from "./record-fixtures.js"

export interface Aimock {
  readonly port: number
  /** Base URL with the `/v1` suffix the OpenAI SDK expects. */
  readonly baseUrl: string
  /** Append more fixtures onto the live mock without restarting it. */
  addFixtures(fixtures: readonly AimockFixture[]): void
  /** Remove all registered fixtures (the mock keeps running). */
  clearFixtures(): void
  /** All requests the mock has received (aimock's journal). */
  getRequests(): ReadonlyArray<{
    body: {
      messages?: Array<{ role: string; content: unknown }>
      tools?: Array<{ type?: string; function?: { name?: string } }>
    } | null
  }>
  /** Current count of registered fixtures (snapshot point for getRecordingsSince). */
  getFixtureCount(): number
  /**
   * Recordings captured since the given journal length and fixture count — pairs
   * proxied journal entries (request) with newly-recorded fixtures (response),
   * both windowed to a single run so multi-run reuse can't cross-align.
   */
  getRecordingsSince(journalStart: number, fixtureStart: number): readonly Recording[]
  /** Ordered recordings (request + baked response) for proxied calls captured in record mode. */
  getRecordings(): readonly Recording[]
  /**
   * Resolve once every request the mock has received is in its journal. A
   * proxied response reaches the client as the upstream streams it, and aimock
   * records the fixture and journals the request only when the upstream ends,
   * so a run can finish before its own last call is recorded.
   */
  settled(timeoutMs?: number): Promise<void>
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export async function createAimock(opts: {
  readonly fixtures: readonly AimockFixture[]
  /** When set, proxy unmatched requests to the given upstream providers. */
  readonly proxy?: { openai: string }
  /** With proxy: capture (record) proxied responses so getRecordings() returns them. */
  readonly record?: boolean
}): Promise<Aimock> {
  // When recording, use a private temp dir so aimock writes fixtures there
  // instead of ./fixtures/recorded in the caller's CWD.
  const recordTmpDir =
    opts.proxy && opts.record === true
      ? fs.mkdtempSync(path.join(os.tmpdir(), "b4-runmock-record-"))
      : null

  const mock = new LLMock(
    opts.proxy
      ? {
          port: 0,
          chunkSize: 4096,
          record: {
            providers: { openai: opts.proxy.openai },
            proxyOnly: opts.record !== true,
            ...(recordTmpDir !== null ? { fixturePath: recordTmpDir } : {}),
          },
        }
      : { port: 0, chunkSize: 4096 },
  )
  if (opts.fixtures.length > 0) {
    mock.addFixturesFromJSON(opts.fixtures as never)
  }
  // Record mode sends every call upstream. aimock adds each fixture it records
  // to the fixtures it serves from, so a later request whose last user message
  // contains an earlier one's would be answered with that recording instead:
  // a subagent whose input quotes its parent's request got the parent's `task`
  // calls back (#937). A recorded fixture is kept for getRecordings, but its
  // predicate never matches. Fixtures added through this handle still serve.
  const recordedByAimock = new WeakSet<object>()
  let addingOwnFixtures = false
  if (recordTmpDir !== null) {
    const live = mock.getFixtures() as unknown as Array<{ match: { predicate?: () => boolean } }>
    const push = live.push.bind(live)
    live.push = (...items) => {
      if (!addingOwnFixtures)
        for (const item of items) {
          recordedByAimock.add(item)
          item.match.predicate = () => false
        }
      return push(...items)
    }
  }
  const addOwnFixtures = (fixtures: readonly AimockFixture[]) => {
    addingOwnFixtures = true
    try {
      mock.addFixturesFromJSON(fixtures as never)
    } finally {
      addingOwnFixtures = false
    }
  }
  await mock.start()
  // For settled(): count the requests the server accepts and the entries its
  // journal adds. The journal keeps only its newest 1000 entries, so its length
  // cannot stand in for the count. Both handles are aimock's own
  // `serverInstance` (its node http.Server and Journal).
  const instance = (
    mock as unknown as {
      serverInstance?: {
        server?: import("node:http").Server
        journal?: { add(...args: unknown[]): unknown }
      }
    }
  ).serverInstance
  let received = 0
  let journaled = 0
  instance?.server?.on("request", () => {
    received++
  })
  const journal = instance?.journal
  if (journal) {
    const add = journal.add.bind(journal)
    journal.add = (...args: unknown[]) => {
      journaled++
      return add(...args)
    }
  }

  // Capture the fixture count at start so getRecordings() can diff against it.
  const initialFixtureCount = mock.getFixtures().length

  // Local helper — windowed to [journalStart, fixtureStart) so multi-run reuse
  // can't cross-align recorded responses with the wrong requests.
  const getRecordingsSince = (journalStart: number, fixtureStart: number): readonly Recording[] => {
    const newFixtures = (
      mock.getFixtures().slice(fixtureStart) as unknown as RecordedFixture[]
    ).filter((fixture) => recordedByAimock.has(fixture))
    if (newFixtures.length === 0) return []
    const proxyEntries = (
      mock.getRequests() as ReadonlyArray<{
        body: RecordedRequest | null
        response?: { source?: string }
      }>
    )
      .slice(journalStart)
      .filter((e) => e.response?.source === "proxy")
      .map((e) => e.body ?? {})
    return pairRecordings(newFixtures, proxyEntries)
  }

  let stopped = false
  const handle: Aimock = {
    port: mock.port,
    baseUrl: `${mock.url}/v1`,
    addFixtures(fixtures: readonly AimockFixture[]) {
      if (fixtures.length > 0) {
        addOwnFixtures(fixtures)
      }
    },
    clearFixtures() {
      mock.clearFixtures()
    },
    async settled(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs
      while (journal && journaled < received && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10))
    },
    getRequests() {
      return mock.getRequests() as ReadonlyArray<{
        body: {
          messages?: Array<{ role: string; content: unknown }>
          tools?: Array<{ type?: string; function?: { name?: string } }>
        } | null
      }>
    },
    getFixtureCount() {
      return mock.getFixtures().length
    },
    getRecordingsSince(journalStart: number, fixtureStart: number): readonly Recording[] {
      return getRecordingsSince(journalStart, fixtureStart)
    },
    getRecordings(): readonly Recording[] {
      return getRecordingsSince(0, initialFixtureCount)
    },
    async close() {
      if (stopped) return
      stopped = true
      await mock.stop()
      if (recordTmpDir !== null) {
        fs.rmSync(recordTmpDir, { recursive: true, force: true })
      }
    },
    [Symbol.asyncDispose](): Promise<void> {
      return this.close()
    },
  }
  return handle
}

interface RecordedRequest {
  readonly messages?: Array<{ role: string; content: unknown; tool_call_id?: unknown }>
  readonly tools?: Array<{ type?: string; function?: { name?: string } }>
}

interface RecordedFixture {
  readonly match: Record<string, unknown>
  readonly response: AimockResponse
  readonly metadata?: { readonly systemHash?: string; readonly toolsHash?: string }
}

/**
 * What aimock's recorder stamps on the fixture it writes for `request` — the
 * match fields and drift hashes of `buildFixtureMatch`/`buildFixtureMetadata`
 * in `@copilotkit/aimock`'s recorder — so a recorded response can be paired
 * with the request that produced it.
 */
function recordedKey(request: RecordedRequest): string {
  const messages = request.messages ?? []
  const lastUser = [...messages].reverse().find((m) => m.role === "user")
  const text = lastUser ? getTextContent(lastUser.content as never) : null
  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i]?.role === "user") {
      lastUserIndex = i
      break
    }
  const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 8)
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n")
  return JSON.stringify([
    text ? text : null,
    messages.length > 0 ? messages.filter((m) => m.role === "assistant").length : null,
    messages.length > 0 ? messages.slice(lastUserIndex + 1).some((m) => m.role === "tool") : null,
    system ? hash(system) : null,
    request.tools && request.tools.length > 0 ? hash(JSON.stringify(request.tools)) : null,
  ])
}

function fixtureKey(fixture: RecordedFixture): string {
  const { match, metadata } = fixture
  return JSON.stringify([
    typeof match.userMessage === "string" ? match.userMessage : null,
    typeof match.turnIndex === "number" ? match.turnIndex : null,
    typeof match.hasToolResult === "boolean" ? match.hasToolResult : null,
    metadata?.systemHash ?? null,
    metadata?.toolsHash ?? null,
  ])
}

/**
 * Pair each recorded response with the request that produced it. aimock appends
 * a fixture when its upstream response completes and the journal entry after
 * that, so when a route's subagents call the model concurrently the two lists
 * need not be in the same order, and pairing them by position files one run's
 * response under another run's request (#937). A fixture is paired with the
 * first unpaired request it was recorded from; requests that look identical
 * to aimock are interchangeable on replay, so which of them it takes does not
 * matter.
 */
export function pairRecordings(
  fixtures: readonly RecordedFixture[],
  requests: readonly RecordedRequest[],
): Recording[] {
  const keys = requests.map(recordedKey)
  const paired = new Set<number>()
  return fixtures.map((fixture, n): Recording => {
    const key = fixtureKey(fixture)
    const i = keys.findIndex((candidate, index) => !paired.has(index) && candidate === key)
    if (i === -1)
      throw new Error(
        `Recorded response ${n} matches no proxied request in this run, so it cannot be ` +
          "keyed for replay.",
      )
    paired.add(i)
    const request = requests[i] as RecordedRequest
    return {
      request: {
        ...(request.messages !== undefined ? { messages: request.messages } : {}),
        ...(request.tools !== undefined ? { tools: request.tools } : {}),
      },
      response: fixture.response,
    }
  })
}
