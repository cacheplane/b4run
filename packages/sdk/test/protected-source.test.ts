import { expect, it } from "vitest"
import type { RuntimeProtectedSourceRecord } from "../src/agent-protocol/storage.ts"
import { protectedSourceDigest } from "../src/pure/protected-source.ts"

it("preserves stopped-source digest through semantic object reconstruction", () => {
  const identity = {
    v: 1,
    kind: "protected_source",
    aliasId: "source",
    threadId: "thread",
    generation: "generation",
    runId: "new",
    preRunCheckpointId: "safe",
    sourceRunId: "stopped",
    sourceCheckpointId: "physical",
    checkpointOwnerRunId: "original",
    sourceDigest: null,
    sourceRunIds: ["stopped"],
    agents: ["root"],
    stoppedSource: {
      v: 1,
      kind: "started_unwound",
      creatorMethod: "input.respond",
      execution: { ownerId: "owner", fence: 2 },
      startedAt: "2026-11-05T00:00:00.000Z",
      unwoundAt: "2026-11-05T00:00:01.000Z",
      path: [
        {
          runId: "stopped",
          previousRunId: "original",
          receiptId: "receipt",
          selectedHead: "physical",
          protectedSource: null,
        },
      ],
    },
  } as const satisfies Omit<RuntimeProtectedSourceRecord, "digest">
  const reorder = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(reorder)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, item]) => [key, reorder(item)]),
          )
        : value
  const rebuilt = JSON.parse(JSON.stringify(reorder(identity))) as typeof identity
  expect(protectedSourceDigest(rebuilt)).toBe(protectedSourceDigest(identity))
})
