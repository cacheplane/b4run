// A thread replayed through `GET /threads/:id/events` restores the chat its
// live AG-UI run showed. Both sides go through the real runtime: the live side
// POSTs `RunAgentInput` to the AG-UI endpoint and reads the SSE events; the
// replayed side reads the checkpoints back as events.
//
// Two comparisons:
//
// - The chat. `chatOf` projects an event list onto what a chat client shows:
//   user messages, assistant text, tool calls with their args, tool results,
//   and the final run outcome. It is a small in-test projection, not
//   `@ag-ui/client`: applying a replay through `@ag-ui/client`'s `connect`
//   path (verifier included) is covered against the synthesiser directly in
//   `packages/ag-ui/test/view/events-from-state.test.ts`.
// - The turns. Folding the replayed events through `reduceTurns` equals the
//   `/turns` body, normalised as in `thread-turns-equivalence.test.ts`.
//
// Deliberate, documented differences the comparison normalises away:
//
// - Message and tool-call ids: live carries the stream's ids; replay carries
//   the checkpoint messages' ids. Both become first-seen ordinals (`m0`, `c0`).
//   A call's `parentMessageId` shares the message ordinals, so both sides must
//   file each call under the same model message — a tool-only one included.
// - The user message: live `RUN_STARTED` carries no `input` (the client
//   already holds what it sent), so the live chat is seeded with the text the
//   test sent; replay carries it in `RUN_STARTED.input.messages`.
// - Run boundaries: a parked turn resumed by a second run is two live runs and
//   one replayed run. The chat is projected over the whole stream, so only the
//   final outcome is compared; the resuming run adds no user message.
// - A resumed call: the live resuming run re-presents the parked call
//   (`TOOL_CALL_START`/`ARGS`/`END` under the same tool-call id, args resent
//   whole) before its result; replay carries the call once. `chatOf` keys
//   calls by id, so a re-presented call updates its entry instead of adding
//   one, and its args are the re-sent ones.
// - Events tagged `subagentRunId` are dropped on both sides: the chat never
//   shows a subagent's inner messages.
// - Turn-level normalisation (run ids, clocks, reasoning ids)
//   is `thread-turns-equivalence.test.ts`'s, reused verbatim.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { BaseEvent } from "@ag-ui/core"
import { reduceTurns, type TurnsView } from "@b4run/ag-ui/view"
import { afterEach, describe, expect, it } from "vitest"
import { createAimock } from "../../testing/dist/aimock-runner.js"
import { script } from "../../testing/dist/fixture-builder.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

// ---------------------------------------------------------------------------
// Fixture app: the routes thread-turns-endpoint.test.ts uses
// ---------------------------------------------------------------------------

/** Agent route whose `deployProd` tool requires human approval, so the first
 * call to it parks the turn on a real checkpointer-backed HITL interrupt. */
const PARK_ROUTE = [
  'import { agent } from "@b4run/sdk"',
  "export default agent({",
  '  model: "gpt-5-mini",',
  '  systemPrompt: "You are a test agent. Use the provided tools when asked.",',
  '  tools: { approve: ["deployProd"] },',
  "})",
  "",
].join("\n")

/** Agent route with one ungated tool: a run through it drains without parking. */
const SEARCH_ROUTE = [
  'import { agent } from "@b4run/sdk"',
  "export default agent({",
  '  model: "gpt-5-mini",',
  '  systemPrompt: "You are a test agent. Use the provided tools when asked.",',
  "})",
  "",
].join("\n")

/** Both tools declare a `display`, so labels, icons and sources are part of
 * the comparison: live sees a running label and then the done one; restored
 * sees only the stamped done label, and both must land on the same step. */
const DEPLOY_TOOL = [
  'import type { ToolDisplay } from "@b4run/sdk"',
  "/** Deploy to an environment. */",
  "export default async function deployProd(input: { env: string }): Promise<string> {",
  "  return 'deployed to ' + input.env",
  "}",
  "export const display: ToolDisplay<{ env: string }, string> = {",
  '  icon: "run",',
  "  running: (input) => 'Deploying to ' + input.env + '…',",
  "  done: (input) => 'Deployed to ' + input.env,",
  "}",
  "",
].join("\n")

const SEARCH_TOOL = [
  'import type { ToolDisplay } from "@b4run/sdk"',
  "/** Search the corpus. */",
  "export default async function searchCorpus(input: { query: string }): Promise<string> {",
  "  return '3 hits'",
  "}",
  "export const display: ToolDisplay<{ query: string }, string> = {",
  '  icon: "search",',
  "  running: (input) => 'Searching the corpus for ' + input.query + '…',",
  "  done: (input, output) => 'Searched the corpus for ' + input.query + ': ' + output,",
  '  sources: () => [{ title: "Corpus", href: "https://example.test/corpus" }],',
  "}",
  "",
].join("\n")

async function fixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-thread-events-eq-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "b4.config.ts": "export default {}\n",
    "package.json": '{ "name": "thread-events-equivalence-fixture", "type": "module" }\n',
    "src/app/park/index.ts": PARK_ROUTE,
    "src/app/park/tools/deployProd.ts": DEPLOY_TOOL,
    "src/app/search/index.ts": SEARCH_ROUTE,
    "src/app/search/tools/searchCorpus.ts": SEARCH_TOOL,
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

/** Point OPENAI_BASE_URL/OPENAI_API_KEY at a local aimock for this test,
 * restoring the previous env afterward. Call BEFORE creating the handler. */
async function withAimock(fixtures: ReturnType<ReturnType<typeof script>["build"]>): Promise<void> {
  const aimock = await createAimock({ fixtures: [] })
  cleanup.push(() => aimock.close())
  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
  cleanup.push(() => {
    if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prevBaseUrl
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
  })
  aimock.addFixtures(fixtures)
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

type Handler = Awaited<ReturnType<typeof createHandler>>

// ---------------------------------------------------------------------------
// The live side: POST RunAgentInput to /agui/<route>, fold the SSE events
// ---------------------------------------------------------------------------

interface AguiRunOptions {
  readonly threadId: string
  readonly runId: string
  readonly route: string
  readonly message: string
  readonly resume?: readonly unknown[]
}

function parseSseEvents(text: string): BaseEvent[] {
  return text.split("\n\n").flatMap((frame) => {
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length)
    return data ? [JSON.parse(data) as BaseEvent] : []
  })
}

async function aguiRun(handler: Handler, options: AguiRunOptions): Promise<BaseEvent[]> {
  const response = await handler.fetch(
    new Request(`http://localhost/agui/${encodeURIComponent(options.route)}`, {
      body: JSON.stringify({
        context: [],
        forwardedProps: {},
        messages: [{ content: options.message, id: `u-${options.runId}`, role: "user" }],
        runId: options.runId,
        state: {},
        threadId: options.threadId,
        tools: [],
        ...(options.resume !== undefined ? { resume: options.resume } : {}),
      }),
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      method: "POST",
    }),
  )
  expect(response.status).toBe(200)
  return parseSseEvents(await response.text())
}

/** Fold events with a fixed clock sequence: the Nth event lands at N. */
function fold(state: TurnsView, events: readonly BaseEvent[]): TurnsView {
  let clock = 0
  const now = () => clock
  let view = state
  for (const event of events) {
    clock += 1
    view = reduceTurns(view, event, { now })
  }
  return view
}

// ---------------------------------------------------------------------------
// The restored side
// ---------------------------------------------------------------------------

interface TurnsBody {
  readonly threadId: string
  readonly status: "idle" | "busy" | "interrupted"
  readonly turns: TurnsView
  readonly warnings: readonly string[]
  readonly truncated: boolean
}

async function readTurns(handler: Handler, threadId: string): Promise<TurnsBody> {
  const response = await handler.fetch(new Request(`http://localhost/threads/${threadId}/turns`))
  expect(response.status).toBe(200)
  return (await response.json()) as TurnsBody
}

// ---------------------------------------------------------------------------
// Normalisation: the documented differences listed at the top of this file
// ---------------------------------------------------------------------------

const CLOCK_KEYS: ReadonlySet<string> = new Set(["startedAt", "settledAt", "endedAt", "updatedAt"])

function normaliseValue(value: unknown, path: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => normaliseValue(item, path))
  if (typeof value !== "object" || value === null) return value
  const record = value as Record<string, unknown>
  const isReasoning = record.kind === "reasoning"
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    if (key === "runId") out[key] = "turn"
    else if (CLOCK_KEYS.has(key) && typeof item === "number") out[key] = 0
    else if (isReasoning && (key === "id" || key === "messageId")) out[key] = "r"
    else if (key === "grant" && path.at(-1) === "approval") continue
    else out[key] = normaliseValue(item, [...path, key])
  }
  return out
}

function normalised(view: TurnsView): unknown {
  return normaliseValue(view, [])
}

// ---------------------------------------------------------------------------
// The replayed side
// ---------------------------------------------------------------------------

interface EventsBody {
  readonly threadId: string
  readonly status: "idle" | "busy" | "interrupted"
  readonly events: readonly BaseEvent[]
  readonly warnings: readonly string[]
  readonly truncated: boolean
}

async function readEvents(handler: Handler, threadId: string): Promise<EventsBody> {
  const response = await handler.fetch(new Request(`http://localhost/threads/${threadId}/events`))
  expect(response.status).toBe(200)
  return (await response.json()) as EventsBody
}

// ---------------------------------------------------------------------------
// The chat a client shows, projected from an event list
// ---------------------------------------------------------------------------

type ChatEntry =
  | { readonly role: "user"; readonly id: string; readonly content: string }
  | { readonly role: "assistant"; readonly id: string; content: string }
  | {
      readonly role: "toolCall"
      readonly id: string
      readonly name: string
      /** The model message the call is filed under (`parentMessageId`), as a message ordinal. */
      readonly parent: string
      args: string
    }
  | { readonly role: "tool"; readonly toolCallId: string; readonly content: string }

interface Chat {
  readonly entries: readonly ChatEntry[]
  readonly outcome: { readonly type: string; readonly interruptIds?: readonly string[] } | null
}

type Ev = BaseEvent & { readonly [key: string]: unknown }

/** Ids become first-seen ordinals so live and replayed ids compare by position. */
function ordinals(prefix: string): (id: string) => string {
  const seen = new Map<string, string>()
  return (id) => {
    let ordinal = seen.get(id)
    if (ordinal === undefined) {
      ordinal = `${prefix}${seen.size}`
      seen.set(id, ordinal)
    }
    return ordinal
  }
}

/**
 * The chat a client would show for `events`: user messages from
 * `RUN_STARTED.input.messages` (or `seedUserText` for a live stream, whose
 * `RUN_STARTED` has no input), assistant text per message id, tool calls with
 * their concatenated args, tool results, in order; subagent-tagged events are
 * skipped; `outcome` is the last run's.
 */
function chatOf(events: readonly BaseEvent[], seedUserText?: string): Chat {
  const messageId = ordinals("m")
  const callId = ordinals("c")
  const entries: ChatEntry[] = []
  const texts = new Map<string, Extract<ChatEntry, { role: "assistant" }>>()
  const calls = new Map<string, Extract<ChatEntry, { role: "toolCall" }>>()
  let outcome: Chat["outcome"] = null
  if (seedUserText !== undefined) {
    entries.push({ content: seedUserText, id: messageId("seed"), role: "user" })
  }
  for (const raw of events) {
    const event = raw as Ev
    if (event.subagentRunId !== undefined) continue
    switch (event.type) {
      case "RUN_STARTED": {
        const input = event.input as
          | { messages?: ReadonlyArray<Record<string, unknown>> }
          | undefined
        for (const message of input?.messages ?? []) {
          if (message.role !== "user") continue
          entries.push({
            content: String(message.content),
            id: messageId(String(message.id)),
            role: "user",
          })
        }
        break
      }
      case "TEXT_MESSAGE_START": {
        const entry = {
          content: "",
          id: messageId(String(event.messageId)),
          role: "assistant" as const,
        }
        texts.set(String(event.messageId), entry)
        entries.push(entry)
        break
      }
      case "TEXT_MESSAGE_CONTENT": {
        const entry = texts.get(String(event.messageId))
        expect(
          entry,
          `TEXT_MESSAGE_CONTENT for an unstarted message ${String(event.messageId)}`,
        ).toBeDefined()
        if (entry) entry.content += String(event.delta)
        break
      }
      case "TOOL_CALL_START": {
        expect(
          event.parentMessageId,
          `TOOL_CALL_START without parentMessageId for ${String(event.toolCallId)}`,
        ).toEqual(expect.any(String))
        const known = calls.get(String(event.toolCallId))
        if (known) {
          // A resumed run re-presents its parked call under the same id, args
          // included: the same call, not a second one. A client keeps it in the
          // message it was first filed under, so its parent is the first one.
          expect(known.name).toBe(String(event.toolCallName))
          known.args = ""
          break
        }
        const entry = {
          args: "",
          id: callId(String(event.toolCallId)),
          name: String(event.toolCallName),
          parent: messageId(String(event.parentMessageId)),
          role: "toolCall" as const,
        }
        calls.set(String(event.toolCallId), entry)
        entries.push(entry)
        break
      }
      case "TOOL_CALL_ARGS": {
        const entry = calls.get(String(event.toolCallId))
        expect(
          entry,
          `TOOL_CALL_ARGS for an unstarted call ${String(event.toolCallId)}`,
        ).toBeDefined()
        if (entry) entry.args += String(event.delta)
        break
      }
      case "TOOL_CALL_RESULT":
        entries.push({
          content: String(event.content),
          role: "tool",
          toolCallId: callId(String(event.toolCallId)),
        })
        break
      case "RUN_FINISHED": {
        const result = event.outcome as
          | { type: string; interrupts?: ReadonlyArray<{ id: string }> }
          | undefined
        const type = result?.type ?? "success"
        outcome =
          type === "interrupt"
            ? { interruptIds: (result?.interrupts ?? []).map((i) => i.id), type }
            : { type }
        break
      }
      case "RUN_ERROR":
        outcome = { type: "error" }
        break
    }
  }
  return { entries, outcome }
}

/** Every TEXT_MESSAGE_START/TOOL_CALL_START has its END before its run's terminal event. */
function expectClosedStreams(events: readonly BaseEvent[]): void {
  const open = new Set<string>()
  for (const raw of events) {
    const event = raw as Ev
    if (event.type === "TEXT_MESSAGE_START") open.add(`text:${String(event.messageId)}`)
    else if (event.type === "TEXT_MESSAGE_END") {
      expect(open.delete(`text:${String(event.messageId)}`)).toBe(true)
    } else if (event.type === "TOOL_CALL_START") open.add(`call:${String(event.toolCallId)}`)
    else if (event.type === "TOOL_CALL_END") {
      expect(open.delete(`call:${String(event.toolCallId)}`)).toBe(true)
    } else if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
      expect([...open], `open at ${event.type}`).toEqual([])
    }
  }
  expect(["RUN_FINISHED", "RUN_ERROR"]).toContain(events.at(-1)?.type)
}

// ---------------------------------------------------------------------------

describe("a thread replayed through GET /threads/:id/events restores its live chat", () => {
  it("drained /search#agent run: replay chat equals live chat; folded replay equals /turns", async () => {
    await withAimock(
      script()
        .user("search")
        .callsTool("searchCorpus", { query: "x" })
        .replies("Found it.")
        .build(),
    )
    const handler = await createHandler(await fixtureApp())

    const live = await aguiRun(handler, {
      message: "search",
      route: "/search#agent",
      runId: "run-1",
      threadId: "t-ev-search",
    })
    const replay = await readEvents(handler, "t-ev-search")
    expect(replay.status).toBe("idle")
    expect(replay.warnings).toEqual([])
    expect(replay.truncated).toBe(false)
    expectClosedStreams(replay.events)

    const liveChat = chatOf(live, "search")
    // The premise: user → search call → its result → the answer, drained.
    expect(liveChat).toEqual({
      entries: [
        { content: "search", id: "m0", role: "user" },
        {
          args: JSON.stringify({ query: "x" }),
          id: "c0",
          name: "searchCorpus",
          parent: "m1",
          role: "toolCall",
        },
        { content: expect.any(String), role: "tool", toolCallId: "c0" },
        { content: "Found it.", id: "m2", role: "assistant" },
      ],
      outcome: { type: "success" },
    })
    expect(chatOf(replay.events)).toEqual(liveChat)

    const turns = await readTurns(handler, "t-ev-search")
    expect(normalised(fold({ turns: [] }, replay.events))).toEqual(normalised(turns.turns))
  }, 60_000)

  it("parked /park#agent run: both end on the deployProd call and the same interrupt; resumed: same chat", async () => {
    await withAimock(
      script()
        .user("deploy")
        .callsTool("deployProd", { env: "staging" })
        .replies("Deployed.")
        .build(),
    )
    const handler = await createHandler(await fixtureApp())

    const liveParkEvents = await aguiRun(handler, {
      message: "deploy",
      route: "/park#agent",
      runId: "run-park",
      threadId: "t-ev-park",
    })
    const parked = await readEvents(handler, "t-ev-park")
    expect(parked.status).toBe("interrupted")
    expect(parked.warnings).toEqual([])
    expectClosedStreams(parked.events)

    const liveParked = chatOf(liveParkEvents, "deploy")
    const replayParked = chatOf(parked.events)
    for (const chat of [liveParked, replayParked]) {
      expect(chat.entries.at(-1)).toMatchObject({ name: "deployProd", role: "toolCall" })
      expect(chat.entries.some((entry) => entry.role === "tool")).toBe(false)
      expect(chat.outcome?.type).toBe("interrupt")
      expect(chat.outcome?.interruptIds).toHaveLength(1)
    }
    const interruptId = liveParked.outcome?.interruptIds?.[0] ?? ""
    expect(interruptId).not.toBe("")
    expect(replayParked.outcome?.interruptIds).toEqual([interruptId])
    expect(replayParked).toEqual(liveParked)
    expect(normalised(fold({ turns: [] }, parked.events))).toEqual(
      normalised((await readTurns(handler, "t-ev-park")).turns),
    )

    const liveResumeEvents = await aguiRun(handler, {
      message: "deploy",
      resume: [{ interruptId, payload: "once", status: "resolved" }],
      route: "/park#agent",
      runId: "run-resume",
      threadId: "t-ev-park",
    })
    const done = await readEvents(handler, "t-ev-park")
    expect(done.status).toBe("idle")
    expect(done.warnings).toEqual([])
    expectClosedStreams(done.events)
    expect(done.events.filter((event) => event.type === "RUN_STARTED")).toHaveLength(1)

    const liveDone = chatOf([...liveParkEvents, ...liveResumeEvents], "deploy")
    expect(liveDone).toEqual({
      entries: [
        { content: "deploy", id: "m0", role: "user" },
        {
          args: JSON.stringify({ env: "staging" }),
          id: "c0",
          name: "deployProd",
          parent: "m1",
          role: "toolCall",
        },
        { content: expect.any(String), role: "tool", toolCallId: "c0" },
        { content: "Deployed.", id: "m2", role: "assistant" },
      ],
      outcome: { type: "success" },
    })
    expect(chatOf(done.events)).toEqual(liveDone)
    expect(normalised(fold({ turns: [] }, done.events))).toEqual(
      normalised((await readTurns(handler, "t-ev-park")).turns),
    )
  }, 90_000)
})
