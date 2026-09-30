import type { PermissionsStore } from "@b4run/permissions"
import { CLIENT_TOOL_RECORDER_KEY, type ClientToolRecorder } from "@b4run/sdk"
import { Annotation, Command, END, MemorySaver, START, StateGraph } from "@langchain/langgraph"
import { describe, expect, it } from "vitest"
import {
  ABANDONED_CLIENT_TOOL_RESULT,
  type ClientToolDefinition,
  createClientToolStub,
  isClientToolCallEnvelope,
  MissingClientToolRecorderError,
} from "../../src/capabilities/client-tools.js"

const State = Annotation.Root({
  output: Annotation<unknown>({ reducer: (_a, b) => b, default: () => undefined }),
})

const definition: ClientToolDefinition = {
  name: "openPanel",
  description: "Open a panel in the client UI.",
  parameters: { type: "object", properties: { id: { type: "number" } } },
}

type RecordCall = Parameters<ClientToolRecorder["record"]>[0]

/** Backed by what it has recorded, like the real store's `(threadId, toolCallId)` key. */
function recordingRecorder(): ClientToolRecorder & {
  readonly calls: RecordCall[]
  readonly hasCalls: string[]
} {
  const calls: RecordCall[] = []
  const hasCalls: string[] = []
  return {
    calls,
    hasCalls,
    async has(toolCallId) {
      hasCalls.push(toolCallId)
      return calls.some((call) => call.toolCallId === toolCallId)
    },
    async record(call) {
      calls.push({ ...call })
    },
  }
}

function store(
  verdicts: Record<string, "allow" | "deny">,
  mode: PermissionsStore["mode"] = "interactive",
): PermissionsStore {
  return {
    mode,
    async load() {},
    match(tool, candidate) {
      return verdicts[`${tool}:${candidate}`] ?? "unknown"
    },
    async addAllow() {},
  }
}

/**
 * A graph whose single node runs the stub the way the tool node would. A real
 * compiled graph, not a faked `getConfig()`: the recorder must arrive through
 * the ambient run config and the park must be a genuine checkpointed interrupt.
 */
function stubGraph(
  permissions: PermissionsStore | undefined,
  context: { toolCallId?: string } = { toolCallId: "call_1" },
) {
  const stub = createClientToolStub(definition, permissions)
  return new StateGraph(State)
    .addNode("tool", async () => {
      const output = await stub.run({ id: 7 }, { signal: new AbortController().signal, ...context })
      return { output }
    })
    .addEdge(START, "tool")
    .addEdge("tool", END)
    .compile({ checkpointer: new MemorySaver() })
}

async function pendingInterrupts(
  app: ReturnType<typeof stubGraph>,
  config: { configurable: Record<string, unknown> },
): Promise<{ id?: string; value?: unknown }[]> {
  const snapshot = await app.getState(config)
  return snapshot.tasks.flatMap((task) => [...(task.interrupts ?? [])])
}

function configFor(recorder?: ClientToolRecorder) {
  return {
    configurable: {
      thread_id: "t",
      ...(recorder ? { [CLIENT_TOOL_RECORDER_KEY]: recorder } : {}),
    } as Record<string, unknown>,
  }
}

async function parkThenResume(
  app: ReturnType<typeof stubGraph>,
  config: { configurable: Record<string, unknown> },
  value: unknown,
): Promise<unknown> {
  await app.invoke({}, config)
  const [pending] = await pendingInterrupts(app, config)
  const resumeKey = pending?.id
  expect(resumeKey).toMatch(/^[0-9a-f]{32}$/)
  return app.invoke(new Command({ resume: { [resumeKey as string]: value } }), config)
}

const expectedEnvelope = {
  type: "client-tool-call",
  interruptId: "client-call_1",
  toolCallId: "call_1",
  name: "openPanel",
  input: { id: 7 },
}

describe("client tool stub", () => {
  it("parks with a stable envelope after recording the call", async () => {
    const recorder = recordingRecorder()
    const app = stubGraph(undefined)
    const config = configFor(recorder)
    await app.invoke({}, config)

    const pending = await pendingInterrupts(app, config)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.value).toEqual(expectedEnvelope)
    expect(recorder.calls).toEqual([
      { toolCallId: "call_1", interruptId: "client-call_1", toolName: "openPanel" },
    ])
  })

  it("resumes with the client's result as a verbatim { result } object", async () => {
    const recorder = recordingRecorder()
    const app = stubGraph(undefined)
    const config = configFor(recorder)
    const resumed = await parkThenResume(app, config, { clientToolResult: "opened" })

    expect((resumed as { output?: unknown }).output).toEqual({ result: "opened" })
    expect(await pendingInterrupts(app, config)).toEqual([])
    // LangGraph re-runs the node from the top on resume: `has` is asked on
    // both passes, and the record is written only on the first.
    expect(recorder.hasCalls).toEqual(["call_1", "call_1"])
    expect(recorder.calls).toEqual([
      { toolCallId: "call_1", interruptId: "client-call_1", toolName: "openPanel" },
    ])
  })

  it("keeps the pre-park permission decision when a deny is added while the call is parked", async () => {
    const verdicts: Record<string, "allow" | "deny"> = {}
    const recorder = recordingRecorder()
    const app = stubGraph(store(verdicts))
    const config = configFor(recorder)
    await app.invoke({}, config)
    const [pending] = await pendingInterrupts(app, config)
    verdicts["clientTool:openPanel"] = "deny"

    const resumed = await app.invoke(
      new Command({ resume: { [pending?.id as string]: { clientToolResult: "opened" } } }),
      config,
    )
    expect((resumed as { output?: unknown }).output).toEqual({ result: "opened" })
  })

  it.each([
    ["a bare string", "deny"],
    ["an empty object", {}],
    ["a non-string result", { clientToolResult: 42 }],
  ])("reads a malformed resume (%s) as abandoned", async (_label, value) => {
    const app = stubGraph(undefined)
    const config = configFor(recordingRecorder())
    const resumed = await parkThenResume(app, config, value)
    expect((resumed as { output?: unknown }).output).toEqual({
      result: ABANDONED_CLIENT_TOOL_RESULT,
    })
  })

  it("returns the coded denial under a clientTool deny, without parking or recording", async () => {
    const recorder = recordingRecorder()
    const app = stubGraph(store({ "clientTool:openPanel": "deny" }))
    const config = configFor(recorder)
    const result = await app.invoke({}, config)

    expect((result as { output?: unknown }).output).toBe(
      "[B4_E3001] Permission denied: client tool openPanel",
    )
    expect(await pendingInterrupts(app, config)).toEqual([])
    expect(recorder.calls).toEqual([])
  })

  it("ignores an allow for the server tool of the same name; the clientTool deny wins", async () => {
    const recorder = recordingRecorder()
    const app = stubGraph(store({ "tool:openPanel": "allow", "clientTool:openPanel": "deny" }))
    const config = configFor(recorder)
    const result = await app.invoke({}, config)

    expect((result as { output?: unknown }).output).toBe(
      "[B4_E3001] Permission denied: client tool openPanel",
    )
    expect(recorder.calls).toEqual([])
  })

  it("allows by default in non-interactive mode: there is no prompt to fail closed on", async () => {
    const recorder = recordingRecorder()
    const app = stubGraph(store({}, "non-interactive"))
    const config = configFor(recorder)
    await app.invoke({}, config)
    const pending = await pendingInterrupts(app, config)
    expect(pending[0]?.value).toEqual(expectedEnvelope)
  })

  it("refuses to park when no recorder was injected", async () => {
    const app = stubGraph(undefined)
    const config = configFor()
    await expect(app.invoke({}, config)).rejects.toBeInstanceOf(MissingClientToolRecorderError)
    expect(await pendingInterrupts(app, config)).toEqual([])
  })

  it("refuses to park without a provider tool-call id", async () => {
    const recorder = recordingRecorder()
    const app = stubGraph(undefined, {})
    const config = configFor(recorder)
    await expect(app.invoke({}, config)).rejects.toThrow(/no provider tool-call id/)
    expect(await pendingInterrupts(app, config)).toEqual([])
    expect(recorder.calls).toEqual([])
  })

  it("names the stub client_<name> and labels its description as caller-authored", () => {
    const stub = createClientToolStub(definition, undefined)
    expect(stub.name).toBe("client_openPanel")
    expect(stub.description).toBe(
      "[Client-provided tool; definition authored by the caller] Open a panel in the client UI.",
    )
    expect(stub.schema).toBe(definition.parameters)
  })
})

describe("isClientToolCallEnvelope", () => {
  it("recognises only the client tool call envelope", () => {
    expect(isClientToolCallEnvelope(expectedEnvelope)).toBe(true)
    expect(isClientToolCallEnvelope({ type: "permission-request", interruptId: "perm-1" })).toBe(
      false,
    )
    expect(isClientToolCallEnvelope({ type: "client-tool-call" })).toBe(false)
    expect(isClientToolCallEnvelope({ type: "client-tool-call", interruptId: "client-x" })).toBe(
      false,
    )
    expect(isClientToolCallEnvelope(null)).toBe(false)
    expect(isClientToolCallEnvelope("client-tool-call")).toBe(false)
    expect(isClientToolCallEnvelope(undefined)).toBe(false)
  })
})
