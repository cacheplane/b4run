import { LLMock } from "@copilotkit/aimock"
import type { AimockFixture, AimockResponse, FixtureSet } from "./fixture-builder.js"

/** One captured real-model exchange: the request the agent sent + the response to bake. */
export interface Recording {
  readonly request: {
    readonly messages?: ReadonlyArray<{
      readonly role: string
      readonly content: unknown
    }>
  }
  readonly response: AimockResponse
}

function firstUserMessage(req: Recording["request"]): string | undefined {
  for (const m of req.messages ?? []) {
    if (m.role === "user" && typeof m.content === "string") return m.content
  }
  return undefined
}

function hasToolResult(req: Recording["request"]): boolean {
  return (req.messages ?? []).some((m) => m.role === "tool")
}

/**
 * Convert ordered recordings (one per LLM call within a single case/thread) into
 * a replay FixtureSet, keyed with the SAME `{userMessage,turnIndex,hasToolResult}`
 * convention `script()` produces — so the recorded file replays through the same
 * aimock matcher with no drift. `turnIndex` is the 0-based ordinal of the call
 * within the thread; `userMessage` is the first user message (stable across the
 * thread); `hasToolResult` is whether a tool-role message is already present.
 */
export function recordingsToFixtures(recordings: readonly Recording[]): FixtureSet {
  const fixtures = recordings.map((rec, turnIndex): AimockFixture => {
    const userMessage = firstUserMessage(rec.request)
    return {
      match: {
        ...(userMessage !== undefined ? { userMessage } : {}),
        turnIndex,
        hasToolResult: hasToolResult(rec.request),
      },
      response: rec.response,
    }
  })
  assertReplayable(fixtures)
  return fixtures
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
  const turns = fixtures.flatMap((fixture, turnIndex) => {
    const error = replayError([fixture])
    if (error === undefined) return []
    const detail = describeValidationError(error)
    const where =
      fixture.match.userMessage !== undefined
        ? `turn ${turnIndex} of ${JSON.stringify(fixture.match.userMessage)}`
        : `turn ${turnIndex}`
    return [`  - ${where}: ${detail}`]
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
