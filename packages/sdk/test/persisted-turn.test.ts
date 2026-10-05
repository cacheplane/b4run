import { describe, expect, test } from "vitest"
import {
  B4_STEP_KEY,
  B4_SUBAGENT_KEY,
  B4_TURN_METADATA_KEY,
  readPersistedStep,
  readPersistedSubagent,
  readPersistedTurnEnd,
} from "../src/persisted-turn.ts"

describe("persisted turn stamps", () => {
  test("keys are the ones the converter, bridge and saver wrapper write", () => {
    expect(B4_STEP_KEY).toBe("b4_step")
    expect(B4_SUBAGENT_KEY).toBe("b4_subagent")
    expect(B4_TURN_METADATA_KEY).toBe("b4:turn")
  })

  test("readPersistedStep accepts a complete stamp and drops invalid optional fields", () => {
    const step = readPersistedStep({
      status: "completed",
      icon: "search",
      label: "Searched the corpus",
      sources: [{ title: "a.md" }, { title: "" }, "x"],
      startedAt: "2026-10-05T00:00:00.000Z",
      settledAt: "2026-10-05T00:00:01.000Z",
      decision: "once",
    })
    expect(step).toEqual({
      status: "completed",
      icon: "search",
      label: "Searched the corpus",
      sources: [{ title: "a.md" }],
      startedAt: "2026-10-05T00:00:00.000Z",
      settledAt: "2026-10-05T00:00:01.000Z",
      decision: "once",
    })
    expect(
      readPersistedStep({
        status: "denied",
        startedAt: "2026-10-05T00:00:00.000Z",
        settledAt: "2026-10-05T00:00:01.000Z",
        icon: "run",
        decision: "deny",
      }),
    ).toMatchObject({ status: "denied", decision: "deny" })
    expect(
      readPersistedStep({
        status: "failed",
        startedAt: "2026-10-05T00:00:00.000Z",
        settledAt: "2026-10-05T00:00:01.000Z",
        icon: "nope",
        decision: "maybe",
      }),
    ).toEqual({
      status: "failed",
      startedAt: "2026-10-05T00:00:00.000Z",
      settledAt: "2026-10-05T00:00:01.000Z",
    })
  })

  test("readPersistedStep rejects a missing status or time", () => {
    expect(readPersistedStep({ status: "completed", startedAt: "x" })).toBeUndefined()
    expect(
      readPersistedStep({
        startedAt: "2026-10-05T00:00:00.000Z",
        settledAt: "2026-10-05T00:00:01.000Z",
      }),
    ).toBeUndefined()
    expect(
      readPersistedStep({
        status: "running",
        startedAt: "2026-10-05T00:00:00.000Z",
        settledAt: "2026-10-05T00:00:01.000Z",
      }),
    ).toBeUndefined()
    expect(readPersistedStep(null)).toBeUndefined()
  })

  test("readPersistedSubagent and readPersistedTurnEnd validate their shapes", () => {
    expect(
      readPersistedSubagent({
        name: "researcher",
        routeId: "/researcher",
        depth: 1,
        checkpointNs: "tools:abc",
        outcome: "done",
        description: "Finds sources",
      }),
    ).toEqual({
      name: "researcher",
      routeId: "/researcher",
      depth: 1,
      checkpointNs: "tools:abc",
      outcome: "done",
      description: "Finds sources",
    })
    expect(
      readPersistedSubagent({
        name: "r",
        routeId: "/r",
        depth: 1,
        checkpointNs: "tools:abc",
        outcome: "lost",
      }),
    ).toBeUndefined()
    expect(
      readPersistedTurnEnd({
        status: "failed",
        error: "boom",
        endedAt: "2026-10-05T00:00:02.000Z",
      }),
    ).toEqual({ status: "failed", error: "boom", endedAt: "2026-10-05T00:00:02.000Z" })
    expect(readPersistedTurnEnd({ status: "done", endedAt: "not a date" })).toBeUndefined()
  })
})
