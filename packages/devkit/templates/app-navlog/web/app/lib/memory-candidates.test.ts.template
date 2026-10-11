import { describe, expect, test } from "vitest"
import {
  describeApprove,
  readApproveOutcome,
  readCandidates,
  readOwnerOnlyMessage,
} from "./memory-candidates"

/**
 * The readers for the three memory endpoints. Every body arrives as JSON over
 * the proxy, so the cases that matter are the malformed ones: each reader has
 * to turn a shape it does not recognize into "nothing to show", never a throw.
 */

describe("describing an approve", () => {
  test("counts what was replaced, singular and plural", () => {
    expect(describeApprove("superseded", 1)).toBe("Replaced 1 earlier memory.")
    expect(describeApprove("superseded", 3)).toBe("Replaced 3 earlier memories.")
  })

  test("says nothing for a plain activation — the row disappearing is the feedback", () => {
    expect(describeApprove("activated", 0)).toBeNull()
  })

  test("a dedupe is worth a word, because nothing visibly changed", () => {
    expect(describeApprove("deduped", 0)).toBe("Already remembered — nothing changed.")
  })

  test("a superseded action with an empty list is treated as a plain activation", () => {
    // Defensive: the server sends the pre-write snapshot, so this shape should
    // not occur — but "Replaced 0 earlier memories" is worse than silence.
    expect(describeApprove("superseded", 0)).toBeNull()
  })
})

describe("reading the candidate list", () => {
  test("keeps entries with a string id and content, with their optional fields", () => {
    const candidate = { id: "a", content: "Works in UTC.", namespace: "profile", tags: ["tz"] }
    expect(readCandidates({ candidates: [candidate] })).toEqual([candidate])
  })

  test("drops entries that could not be rendered or decided on", () => {
    const body = {
      candidates: [
        { id: "a", content: "kept", namespace: "default" },
        { id: 7, content: "numeric id" },
        { id: "b" },
        null,
        "a string",
      ],
    }
    expect(readCandidates(body).map((entry) => entry.id)).toEqual(["a"])
  })

  test("a body without a candidates array reads as empty", () => {
    expect(readCandidates(null)).toEqual([])
    expect(readCandidates({})).toEqual([])
    expect(readCandidates({ candidates: "nope" })).toEqual([])
  })
})

describe("reading the owner-only refusal", () => {
  test("returns the proxy's own message", () => {
    expect(readOwnerOnlyMessage({ error: "owner_only", message: "Only the owner can." })).toBe(
      "Only the owner can.",
    )
  })

  test("anything else is not an owner-only refusal", () => {
    expect(readOwnerOnlyMessage({ error: "forbidden", message: "No." })).toBeNull()
    expect(readOwnerOnlyMessage({ error: "owner_only" })).toBeNull()
    expect(readOwnerOnlyMessage(null)).toBeNull()
  })
})

describe("reading an approve outcome", () => {
  test("counts the superseded list", () => {
    expect(readApproveOutcome({ action: "superseded", superseded: [{}, {}] })).toBe(
      "Replaced 2 earlier memories.",
    )
  })

  test("a dedupe and a plain activation read as describeApprove says", () => {
    expect(readApproveOutcome({ action: "deduped", superseded: [] })).toBe(
      "Already remembered — nothing changed.",
    )
    expect(readApproveOutcome({ action: "activated", superseded: [] })).toBeNull()
  })

  test("a missing or non-array superseded counts as none", () => {
    expect(readApproveOutcome({ action: "superseded" })).toBeNull()
    expect(readApproveOutcome({ action: "superseded", superseded: 2 })).toBeNull()
  })

  test("an unknown action or a malformed body says nothing", () => {
    expect(readApproveOutcome({ action: "archived" })).toBeNull()
    expect(readApproveOutcome(null)).toBeNull()
  })
})
