// Shared pure append preparation/materialization. Native allocation and lookup are tested separately.
import { describe, expect, it } from "vitest"
import type { RuntimeJournalRecord } from "../src/agent-protocol/index.ts"
import {
  materializeRuntimeJournalAppend,
  prepareRuntimeJournalAppend,
  type RuntimeJournalAuthority,
} from "../src/internal/runtime-identity.ts"

const GENERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const THREAD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const TURN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const AT = "2026-11-10T00:00:00.000Z"
function authority(): RuntimeJournalAuthority {
  return {
    threadId: THREAD,
    generation: GENERATION,
    owner: {
      runId: RUN,
      threadId: THREAD,
      generation: GENERATION,
      turnId: TURN,
      record: {
        run: {
          run_id: RUN,
          thread_id: THREAD,
          agent_id: "fixture",
          created_at: AT,
          updated_at: AT,
          status: "pending",
          metadata: { callerFact: "retained" },
        },
        metadata: {
          v: 1,
          generation: GENERATION,
          turnId: TURN,
          previousRunId: TURN,
          phase: "running",
          continuation: "none",
          acceptedAt: AT,
          effectsUncertain: false,
        },
        namespace: [],
        preRunCheckpointId: null,
        result: null,
      },
    },
  }
}
function administrative(): RuntimeJournalAuthority {
  return { threadId: THREAD, generation: GENERATION, owner: null }
}
function draft(namespace: string[] = [], data: unknown = { ready: true }) {
  return {
    namespace,
    ownerRunId: null as string | null,
    event: {
      type: "event" as const,
      method: "values" as const,
      params: { namespace: [...namespace], timestamp: 0, data },
    },
  }
}
function untypedAuthority(value: unknown): RuntimeJournalAuthority {
  return value as RuntimeJournalAuthority // Deliberately invalid runtime vectors bypass TS only here.
}
function event(record: RuntimeJournalRecord): Record<string, unknown> {
  return record.event as unknown as Record<string, unknown>
}

describe("canonical runtime journal", () => {
  it("materializes canonical journal coordinates and stored continuation turn correlation", () => {
    const stored = authority()
    const namespace = ["child/slash", "leaf"]
    const data = {
      event: "running",
      graphName: "child",
      cause: { type: "toolCall", toolCallId: "call-1" },
    }
    const input = {
      ownerRunId: RUN,
      namespace,
      event: {
        type: "event",
        method: "lifecycle",
        params: { namespace: [...namespace], timestamp: 0, data },
      },
    }
    const prepared = prepareRuntimeJournalAppend(input, stored)
    const changedOwner = stored as unknown as {
      owner: { turnId: string; record: { metadata: { turnId: string } } }
    }
    changedOwner.owner.turnId = OTHER
    changedOwner.owner.record.metadata.turnId = OTHER
    const actual = materializeRuntimeJournalAppend(prepared, 1)
    const id = "b4e1.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.1"
    expect(actual.record.eventId).toBe(id)
    expect(actual.record.seq).toBe(1)
    expect(actual.record.ownerRunId).toBe(RUN)
    expect(actual.record.namespace).toEqual(namespace)
    expect(event(actual.record)).toEqual({
      ...input.event,
      eventId: id,
      seq: 1,
      b4: { v: 1, generation: GENERATION, runId: RUN, turnId: TURN },
    })
    expect(event(actual.record).b4).not.toEqual({
      v: 1,
      generation: GENERATION,
      runId: RUN,
      turnId: RUN,
    })
    expect(actual.record.event.params.data).toEqual(data)
    expect(stored.owner?.record.namespace).toEqual([]) // Child facts do not require root-namespace equality.
    expect(JSON.parse(actual.recordJson)).toEqual(actual.record)
    expect(JSON.parse(actual.namespaceJson)).toEqual(namespace)
    expect(actual.recordJson).toMatch(/^[\x20-\x7e]*$/)
  })

  it("keeps administrative namespace components exact and detaches journal data", () => {
    const namespaces = [
      [],
      [""],
      ["/"],
      ["a/b"],
      ["a", "b"],
      ["", ""],
      ["\0"],
      ["\\u0000"],
      ["é"],
      ["e\u0301"],
      ["\\u0061"],
    ]
    const encoded: string[] = []
    for (const [index, namespace] of namespaces.entries()) {
      const input = draft(namespace)
      const actual = materializeRuntimeJournalAppend(
        prepareRuntimeJournalAppend(input, administrative()),
        index + 1,
      )
      encoded.push(actual.namespaceJson)
      expect(actual.record.namespace).toEqual(namespace)
      expect(actual.record.event.params.namespace).toEqual(namespace)
      expect(JSON.parse(actual.namespaceJson)).toEqual(namespace)
      const b4 = event(actual.record).b4 as Record<string, unknown>
      expect(b4).toEqual({ v: 1, generation: GENERATION })
      expect(Object.hasOwn(b4, "runId")).toBe(false)
      expect(Object.hasOwn(b4, "turnId")).toBe(false)
    }
    expect(new Set(encoded).size).toBe(namespaces.length)
    const source = { nested: { items: ["original"] } }
    const namespace = ["original"]
    const input = draft(namespace, source)
    const prepared = prepareRuntimeJournalAppend(input, administrative())
    namespace[0] = "caller changed namespace"
    input.event.params.namespace[0] = "caller changed embedded namespace"
    source.nested.items.push("caller changed data")
    const first = materializeRuntimeJournalAppend(prepared, 1)
    const retained = first.recordJson
    expect(first.record.namespace).toEqual(["original"])
    expect(first.record.event.params.namespace).toEqual(["original"])
    expect(first.record.event.params.data).toEqual({ nested: { items: ["original"] } })
    // Frozen or detached return values are both acceptable. Neither can mutate retained state.
    const mutable = first.record as unknown as {
      namespace: string[]
      event: { params: { data: { nested: { items: string[] } } } }
    }
    try {
      mutable.namespace[0] = "reader mutation"
    } catch {
      /* Frozen return is allowed. */
    }
    try {
      mutable.event.params.data.nested.items.push("reader mutation")
    } catch {
      /* Frozen data is allowed. */
    }
    expect(materializeRuntimeJournalAppend(prepared, 1).recordJson).toBe(retained)
    expect(JSON.parse(retained).event.params.data).toEqual({ nested: { items: ["original"] } })
  })

  it("rejects caller journal coordinates and conflicting authority before allocation", () => {
    function refusal(input: unknown, binding = administrative()): void {
      let allocations = 0
      expect(() => {
        const prepared = prepareRuntimeJournalAppend(input, binding)
        allocations += 1 // PURE phase-boundary witness, not a native sequence/DB allocation.
        materializeRuntimeJournalAppend(prepared, allocations)
      }).toThrow()
      expect(allocations).toBe(0)
    }
    for (const key of ["eventId", "seq", "b4"]) {
      for (const value of [
        undefined,
        key === "seq"
          ? 4
          : key === "eventId"
            ? "caller"
            : { v: 1, runId: OTHER, turnId: OTHER, delivery: "snapshot" },
      ]) {
        const input = draft()
        refusal({ ...input, [key]: value })
        refusal({ ...input, event: { ...input.event, [key]: value } })
      }
    }
    refusal({ ...draft(["a/b"]), event: draft(["a", "b"]).event })
    refusal(draft(new Array<string>(1)))
    refusal({
      ...draft(),
      event: {
        ...draft().event,
        params: { ...draft().event.params, namespace: new Array<string>(1) },
      },
    })
    refusal(draft([1 as unknown as string]))
    for (const value of [
      undefined,
      () => null,
      Symbol("unsupported"),
      1n,
      NaN,
      Infinity,
      new Date(AT),
      new Map(),
      new Set(),
      new Uint8Array([1]),
    ]) {
      const input = draft([], value)
      input.event.params.data = value // Preserve explicit undefined instead of the fixture default.
      refusal(input)
    }
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    refusal(draft([], cycle))
    refusal(draft([], Object.assign([1], { extra: true })))
    let executed = 0
    refusal(
      draft([], {
        toJSON() {
          executed += 1
          return null
        },
      }),
    )
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get() {
        executed += 1
        return "must not execute"
      },
    })
    refusal(draft([], accessor))
    const stampedAccessor = draft()
    Object.defineProperty(stampedAccessor.event, "eventId", {
      enumerable: true,
      get() {
        executed += 1
        return "caller"
      },
    })
    refusal(stampedAccessor)
    expect(executed).toBe(0)
    const owned = { ...draft(), ownerRunId: RUN }
    refusal(owned) // Claimed owner has no current stored Run.
    refusal(draft(), authority()) // Administrative input cannot inherit a non-null owner.
    refusal(owned, { ...authority(), owner: null })
    const nativeMismatch = authority()
    refusal(
      owned,
      untypedAuthority({ ...nativeMismatch, owner: { ...nativeMismatch.owner, runId: OTHER } }),
    )
    for (const field of ["threadId", "generation", "turnId"] as const) {
      const binding = authority()
      refusal(owned, untypedAuthority({ ...binding, owner: { ...binding.owner, [field]: OTHER } }))
    }
    const binding = authority()
    const owner = binding.owner
    if (!owner) throw new Error("Owned vector setup is missing its Run")
    refusal(
      owned,
      untypedAuthority({
        ...binding,
        owner: {
          ...owner,
          record: { ...owner.record, run: { ...owner.record.run, run_id: OTHER } },
        },
      }),
    )
    refusal(
      owned,
      untypedAuthority({
        ...binding,
        owner: {
          ...owner,
          record: { ...owner.record, run: { ...owner.record.run, thread_id: OTHER } },
        },
      }),
    )
    refusal(
      owned,
      untypedAuthority({
        ...binding,
        owner: {
          ...owner,
          record: { ...owner.record, metadata: { ...owner.record.metadata, v: 2 } },
        },
      }),
    )
    refusal(
      owned,
      untypedAuthority({
        ...binding,
        owner: {
          ...owner,
          record: { ...owner.record, metadata: { ...owner.record.metadata, turnId: OTHER } },
        },
      }),
    )
    refusal(
      owned,
      untypedAuthority({
        ...binding,
        owner: {
          ...owner,
          record: { ...owner.record, metadata: { ...owner.record.metadata, generation: OTHER } },
        },
      }),
    )
    refusal(owned, untypedAuthority({ ...binding, owner: { ...owner, record: null } }))
    // The trusted permission service's nested b4 is payload, not caller envelope authority.
    const nested = {
      v: 1,
      pausedGeneration: OTHER,
      proposalHash: "fixture-proposal",
      status: "waiting",
    }
    const permission = {
      ownerRunId: RUN,
      namespace: ["child"],
      event: {
        type: "event",
        method: "input.requested",
        params: {
          namespace: ["child"],
          timestamp: 0,
          data: {
            interruptId: "request",
            b4: nested,
            payload: {
              type: "b4.permission",
              v: 1,
              request: {},
              responseSchema: {},
              allowedDecisions: ["once", "deny"],
              allowAlways: false,
            },
          },
        },
      },
    }
    const valid = materializeRuntimeJournalAppend(
      prepareRuntimeJournalAppend(permission, authority()),
      1,
    )
    expect(valid.record.event.params.data).toEqual(permission.event.params.data)
    expect(event(valid.record).b4).toEqual({
      v: 1,
      generation: GENERATION,
      runId: RUN,
      turnId: TURN,
    })
  })

  it("bounds canonical journal numbering to positive safe integers", () => {
    const prepared = prepareRuntimeJournalAppend(draft(), administrative())
    for (const forged of [{}, { ...prepared }, Object.create(prepared), null]) {
      expect(() => materializeRuntimeJournalAppend(forged as typeof prepared, 1)).toThrow()
    }
    const vectors = [
      [1, "b4e1.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.1"],
      [9007199254740990, "b4e1.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.9007199254740990"],
      [9007199254740991, "b4e1.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.9007199254740991"],
    ] as const
    for (const [seq, id] of vectors) {
      const actual = materializeRuntimeJournalAppend(prepared, seq)
      expect(actual.record.eventId).toBe(id)
      expect(actual.record.seq).toBe(seq)
      expect(event(actual.record).eventId).toBe(id)
      expect(event(actual.record).seq).toBe(seq)
    }
    const schemaUuid = "00000000-0000-0000-0000-000000000000"
    const schemaForm = materializeRuntimeJournalAppend(
      prepareRuntimeJournalAppend(draft(), {
        ...administrative(),
        generation: schemaUuid,
        threadId: "legacy/non-UUID-Thread",
      }),
      1,
    )
    expect(schemaForm.record.eventId).toBe("b4e1.00000000-0000-0000-0000-000000000000.1")
    for (const seq of [0, -0, -1, 1.5, NaN, Infinity, -Infinity, 9007199254740992, "1", 1n]) {
      expect(() => materializeRuntimeJournalAppend(prepared, seq as number)).toThrow()
    }
    for (const generation of [
      GENERATION.toUpperCase(),
      GENERATION.replaceAll("-", ""),
      `{${GENERATION}}`,
      `${GENERATION} `,
      `${GENERATION}\n`,
      "not-a-uuid",
    ]) {
      let allocations = 0
      expect(() => {
        prepareRuntimeJournalAppend(draft(), { ...administrative(), generation })
        allocations += 1
      }).toThrow()
      expect(allocations).toBe(0)
    }
    const owned = { ...draft(), ownerRunId: "noncanonical-owner" }
    const binding = authority()
    expect(() => prepareRuntimeJournalAppend(owned, binding)).toThrow()
  })
})
