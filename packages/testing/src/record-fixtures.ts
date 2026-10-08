import { LLMock, matchFixture } from "@copilotkit/aimock"
import type { AimockFixture, AimockResponse, FixtureSet } from "./fixture-builder.js"

/** One captured real-model exchange: the request the agent sent + the response to bake. */
export interface Recording {
  readonly request: {
    readonly messages?: ReadonlyArray<{
      readonly role: string
      readonly content: unknown
      readonly tool_call_id?: unknown
    }>
    /** The tools the request offered: what tells a parent's turns from its subagents'. */
    readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: unknown } }>
  }
  readonly response: AimockResponse
}

type Request = Recording["request"]

/** The text of a recorded message: a string as is; an array's `text` parts joined (the rule aimock's matcher uses). */
function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((part) =>
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("")
  return text.length > 0 ? text : undefined
}

/** The last user message that has text: the one aimock's `userMessage` matcher reads. */
function lastUserMessage(req: Request): string | undefined {
  const messages = req.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== "user") continue
    const text = messageText(m.content)
    if (text !== undefined) return text
  }
  return undefined
}

/** Assistant messages already in the request: the call's position within its own agent run. */
function assistantTurns(req: Request): number {
  return (req.messages ?? []).filter((m) => m.role === "assistant").length
}

/** Whether a tool result follows the last user message (aimock's current-turn rule). */
function hasToolResult(req: Request): boolean {
  const messages = req.messages ?? []
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUser = i
      break
    }
  }
  return messages.slice(lastUser + 1).some((m) => m.role === "tool")
}

function toolNames(req: Request): string[] {
  return (req.tools ?? []).flatMap((tool) =>
    typeof tool.function?.name === "string" ? [tool.function.name] : [],
  )
}

/** The tool call whose result ends the request, if it ends on one. */
function lastToolCallId(req: Request): string | undefined {
  const last = req.messages?.at(-1)
  return last?.role === "tool" && typeof last.tool_call_id === "string"
    ? last.tool_call_id
    : undefined
}

/**
 * Convert the recordings of one case into a replay FixtureSet. Each fixture is
 * keyed on its own request, read the way aimock's matcher reads it, not on its
 * place in the case:
 * - `userMessage` is the request's last user message;
 * - `turnIndex` is the number of assistant messages already in it, its
 *   position within its own agent run;
 * - `hasToolResult` is whether a tool result follows that user message.
 *
 * That is the convention `script()` produces, and it holds when a route
 * dispatches subagents in parallel: their calls interleave with the parent's in
 * any order, but each request carries only its own run's history (#937).
 * Where two different requests would still match the same fixture (a subagent's
 * input usually contains the parent's message, and aimock matches
 * `userMessage` as a substring), the fixture is narrowed with `toolName` or
 * `toolCallId` until every recorded request is answered by its own response.
 */
export function recordingsToFixtures(recordings: readonly Recording[]): FixtureSet {
  const fixtures = recordings.map((rec): AimockFixture => {
    const userMessage = lastUserMessage(rec.request)
    return {
      match: {
        ...(userMessage !== undefined ? { userMessage } : {}),
        turnIndex: assistantTurns(rec.request),
        hasToolResult: hasToolResult(rec.request),
      },
      response: rec.response,
    }
  })
  assertReplayable(fixtures)
  return disambiguate(recordings, fixtures)
}

/** The fixture aimock serves `req` from `fixtures`, by index, on replay. */
function servedIndex(fixtures: readonly AimockFixture[], req: Request): number {
  const served = matchFixture(
    fixtures as never,
    {
      model: "replay",
      messages: req.messages ?? [],
      tools: toolNames(req).map((name) => ({ type: "function", function: { name } })),
    } as never,
  )
  return served === null ? -1 : fixtures.indexOf(served as unknown as AimockFixture)
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * A narrower copy of fixture `own` that still matches its own request but no
 * longer matches `other`, or undefined when nothing in the request tells them apart.
 */
function narrow(fixture: AimockFixture, own: Request, other: Request): AimockFixture | undefined {
  const otherTools = new Set(toolNames(other))
  const toolName = toolNames(own)
    .filter((name) => !otherTools.has(name))
    .sort()[0]
  if (toolName !== undefined && fixture.match.toolName === undefined)
    return { ...fixture, match: { ...fixture.match, toolName } }
  const toolCallId = lastToolCallId(own)
  if (
    toolCallId !== undefined &&
    toolCallId !== lastToolCallId(other) &&
    fixture.match.toolCallId === undefined
  )
    return { ...fixture, match: { ...fixture.match, toolCallId } }
  return undefined
}

/** Where a recording reads in an error: its run's user message and its position in that run. */
function describeTurn(fixture: AimockFixture): string {
  return fixture.match.userMessage !== undefined
    ? `turn ${fixture.match.turnIndex} of ${JSON.stringify(fixture.match.userMessage)}`
    : `turn ${fixture.match.turnIndex}`
}

/**
 * Replay every recorded request against the fixtures with aimock's own matcher
 * and narrow any fixture that answers a request other than its own. Two
 * identical requests may have recorded different responses (a model is not
 * deterministic); replay serves both the first one, which is still deterministic.
 */
function disambiguate(recordings: readonly Recording[], initial: AimockFixture[]): FixtureSet {
  const fixtures = initial.slice()
  // Each pass either narrows a fixture or stops; a fixture narrows at most twice.
  for (let pass = 0; pass <= 2 * fixtures.length; pass++) {
    const conflicts: string[] = []
    let narrowed = false
    for (const [i, recording] of recordings.entries()) {
      const j = servedIndex(fixtures, recording.request)
      const mine = fixtures[i] as AimockFixture
      if (j === i) continue
      const theirs = fixtures[j]
      const other = recordings[j]
      if (theirs === undefined || other === undefined) {
        conflicts.push(`  - ${describeTurn(mine)}: no recorded fixture matches its own request`)
        continue
      }
      if (same(theirs.response, mine.response) || same(other.request, recording.request)) continue
      const replacement = narrow(theirs, other.request, recording.request)
      if (replacement === undefined) {
        conflicts.push(
          `  - ${describeTurn(mine)} would be answered with the response recorded for ${describeTurn(theirs)}`,
        )
        continue
      }
      fixtures[j] = replacement
      narrowed = true
    }
    if (conflicts.length === 0 && !narrowed) return fixtures
    if (!narrowed)
      throw new Error(
        `Recorded fixtures would not replay deterministically:\n${conflicts.join("\n")}\n` +
          "The requests differ, but not in anything a fixture can match on (the last user " +
          "message, the turn, the tools offered, or the tool call answered). Give each " +
          "subagent a distinct input or a tool of its own.",
      )
  }
  throw new Error("Recorded fixtures would not replay deterministically: narrowing did not settle")
}

/** aimock's own load-time error for one fixture, or undefined when it loads. */
function replayError(fixtures: readonly AimockFixture[]): string | undefined {
  try {
    // The same call replay makes (see createAimock), on a mock that is never
    // started — so a recording is held to exactly the rules its replay will be.
    new LLMock({ port: 0 }).addFixturesFromJSON(fixtures as never)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Refuse a recording that replay would refuse (#778). aimock rejects a
 * fixture whose `content` is an empty string, because its recorder writes one
 * for several different upstream outcomes — a genuinely empty reply, a
 * refusal it does not capture, a reply cut off at the token limit — and a
 * tape cannot say which. Failing here, while the recording is being made,
 * names the turn instead of leaving a tape that breaks on its next replay.
 */
function assertReplayable(fixtures: readonly AimockFixture[]): void {
  const whole = replayError(fixtures)
  if (whole === undefined) return
  const turns = fixtures.flatMap((fixture) => {
    const error = replayError([fixture])
    if (error === undefined) return []
    return [`  - ${describeTurn(fixture)}: ${describeValidationError(error)}`]
  })
  const lines = turns.length > 0 ? turns.join("\n") : `  - ${describeValidationError(whole)}`
  throw new Error(
    `Recorded fixtures would not replay: aimock rejects them on load.\n${lines}\n` +
      "An empty assistant message usually means the model refused (a strict response " +
      "schema reports refusals outside `content`), ran out of output tokens, or was " +
      "given nothing left to do. If the run's answer is a tool call, export " +
      "`returnDirect = true` from that tool so the run ends on its result instead of " +
      "asking the model for a closing message.",
  )
}

/** Reduce aimock's `Fixture validation failed: [...]` to its messages. */
function describeValidationError(error: string): string {
  const prefix = "Fixture validation failed: "
  if (!error.startsWith(prefix)) return error
  try {
    const issues = JSON.parse(error.slice(prefix.length)) as ReadonlyArray<{
      message?: unknown
    }>
    const messages = issues.map((issue) => issue.message).filter((m) => typeof m === "string")
    return messages.length > 0 ? messages.join("; ") : error
  } catch {
    return error
  }
}
