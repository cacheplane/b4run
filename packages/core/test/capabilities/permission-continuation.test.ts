import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionsStore } from "@b4run/permissions/node"
import {
  APPROVAL_GRANT_MINTER_KEY,
  type ApprovalGrantMinter,
  createApprovalGrant,
  createMemoryInterruptGrantStore,
} from "@b4run/sdk"
import { Annotation, Command, END, MemorySaver, START, StateGraph } from "@langchain/langgraph"
import { afterEach, expect, it } from "vitest"
import {
  __resetApprovalGrantsForTests,
  configureApprovalGrants,
  MissingApprovalGrantMinterError,
} from "../../src/capabilities/approval-grants.ts"
import {
  createPermissionContinuationContext,
  PERMISSION_CONTINUATION_KEY,
} from "../../src/capabilities/permission-continuation.ts"
import {
  gatePathOp,
  wrapToolWithApproval,
  wrapToolWithConstraint,
} from "../../src/capabilities/permission-gate.ts"

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing required test fixture value")
  return value
}

const roots: string[] = []
afterEach(() => {
  __resetApprovalGrantsForTests()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
async function graph(sameStore = false, withLater = false) {
  __resetApprovalGrantsForTests()
  const root = mkdtempSync(join(tmpdir(), "b4-core-permission-continuation-"))
  roots.push(root)
  const store = createPermissionsStore({
    appRoot: root,
    config: { version: 1, allow: { tool: ["inspect"] }, deny: {} },
    mode: "interactive",
  })
  await store.load()
  let effects = 0,
    laterEffects = 0
  const tool = wrapToolWithApproval(
    {
      name: "send",
      run: async (_input: unknown, _context: unknown) => {
        effects++
        return "effect"
      },
    },
    store,
  )
  const State = Annotation.Root({ result: Annotation<unknown>() })
  const graph = new StateGraph(State)
    .addNode("gate", async () => ({
      result: await tool.run({ body: "hello" }, { signal: new AbortController().signal }),
    }))
    .addNode("later", async () => {
      if (withLater) {
        const later = wrapToolWithApproval(
          {
            name: "inspect",
            run: async (_input: unknown, _context: unknown) => {
              laterEffects++
              return "later"
            },
          },
          store,
        )
        await later.run({ later: true }, { signal: new AbortController().signal })
      }
      return {}
    })
    .addEdge(START, "gate")
    .addEdge("gate", "later")
    .addEdge("later", END)
    .compile({ checkpointer: new MemorySaver() })
  const config = { configurable: { thread_id: "thread" } }
  await graph.invoke({}, config)
  const writer = sameStore
    ? store
    : createPermissionsStore({ appRoot: root, config: undefined, mode: "interactive" })
  const intent = await required(writer.rememberedRules).prepare("accepted-rule", [
    { tool: "tool", pattern: "send" },
  ])
  await required(writer.rememberedRules).apply(intent)
  const path = join(root, ".b4", "permissions.json")
  return { graph, config, path, effects: () => effects, laterEffects: () => laterEffects }
}
it("skips only the duplicate legacy Always write after exact trusted continuation proof", async () => {
  const f = await graph(),
    before = readFileSync(f.path, "utf8")
  const seen: unknown[] = []
  const context = createPermissionContinuationContext({
    runId: "10000000-0000-4000-8000-000000000001",
    resolve: async (request) => {
      seen.push(request)
      return (
        request.rule.tool === "tool" &&
        request.rule.pattern === "send" &&
        JSON.stringify(request.protectedProposal) === JSON.stringify({ body: "hello" })
      )
    },
  })
  await f.graph.invoke(new Command({ resume: "always" }), {
    configurable: { ...f.config.configurable, [PERMISSION_CONTINUATION_KEY]: context },
  })
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({
    runId: "10000000-0000-4000-8000-000000000001",
    checkpointNs: expect.stringMatching(/^gate:/),
  })
  expect(readFileSync(f.path, "utf8")).toBe(before)
  expect(f.effects()).toBe(1)
})
it("does not restore a later removed rule or execute under its old applied receipt", async () => {
  const f = await graph(),
    file = JSON.parse(readFileSync(f.path, "utf8"))
  file.allow = {}
  writeFileSync(f.path, JSON.stringify(file))
  const context = createPermissionContinuationContext({
    runId: crypto.randomUUID(),
    resolve: async () => true,
  })
  await f.graph.invoke(new Command({ resume: "always" }), {
    configurable: { ...f.config.configurable, [PERMISSION_CONTINUATION_KEY]: context },
  })
  expect(JSON.parse(readFileSync(f.path, "utf8")).allow).toEqual({})
  expect(f.effects()).toBe(0)
})
it("rejects unknown context identities and mismatched actual protected proposals", async () => {
  const f = await graph()
  await expect(
    f.graph.invoke(new Command({ resume: "always" }), {
      configurable: { ...f.config.configurable, [PERMISSION_CONTINUATION_KEY]: {} },
    }),
  ).rejects.toThrow(/permission continuation/i)
  expect(f.effects()).toBe(0)
  const g = await graph()
  const context = createPermissionContinuationContext({
    runId: crypto.randomUUID(),
    resolve: async (request) =>
      JSON.stringify(request.protectedProposal) === JSON.stringify({ body: "changed" }),
  })
  await expect(
    g.graph.invoke(new Command({ resume: "always" }), {
      configurable: { ...g.config.configurable, [PERMISSION_CONTINUATION_KEY]: context },
    }),
  ).rejects.toThrow(/permission continuation/i)
  expect(g.effects()).toBe(0)
})

it("correlates the actual pending gate when the barrier updates the same permissions cache", async () => {
  const f = await graph(true),
    seen: unknown[] = []
  const parked = await f.graph.getState(f.config)
  expect(parked.tasks.flatMap((task) => task.interrupts ?? [])).toHaveLength(1)
  const context = createPermissionContinuationContext({
    runId: crypto.randomUUID(),
    resolve: async (request) => {
      seen.push(request)
      return JSON.stringify(request.protectedProposal) === JSON.stringify({ body: "hello" })
    },
  })
  await f.graph.invoke(new Command({ resume: "always" }), {
    configurable: { ...f.config.configurable, [PERMISSION_CONTINUATION_KEY]: context },
  })
  expect(seen).toHaveLength(1)
  expect((await f.graph.getState(f.config)).tasks.flatMap((task) => task.interrupts ?? [])).toEqual(
    [],
  )
  expect(f.effects()).toBe(1)
  const changed = await graph(true)
  const invalid = createPermissionContinuationContext({
    runId: crypto.randomUUID(),
    resolve: async () => false,
  })
  await expect(
    changed.graph.invoke(new Command({ resume: "always" }), {
      configurable: { ...changed.config.configurable, [PERMISSION_CONTINUATION_KEY]: invalid },
    }),
  ).rejects.toThrow(/permission continuation/i)
  expect(changed.effects()).toBe(0)
})

it("preserves a later ordinary configured-allow gate without creating another prompt", async () => {
  const f = await graph(true, true),
    seen: string[] = []
  const context = createPermissionContinuationContext({
    runId: crypto.randomUUID(),
    resolve: async (request) => {
      seen.push(request.rule.pattern)
      return request.rule.pattern === "send" ? true : undefined
    },
  })
  await f.graph.invoke(new Command({ resume: "always" }), {
    configurable: { ...f.config.configurable, [PERMISSION_CONTINUATION_KEY]: context },
  })
  expect(seen).toEqual(["send", "inspect"])
  expect(f.effects()).toBe(1)
  expect(f.laterEffects()).toBe(1)
  expect((await f.graph.getState(f.config)).tasks.flatMap((task) => task.interrupts ?? [])).toEqual(
    [],
  )
})

for (const changed of ["deny", "true", "throw", "off-contract"] as const) {
  it(`consumes the accepted native slot when the current constraint becomes ${changed}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "b4-core-two-gates-"))
    roots.push(root)
    const store = createPermissionsStore({ appRoot: root, config: undefined, mode: "interactive" })
    await store.load()
    let verdict: "approve" | typeof changed = "approve",
      firstEffects = 0,
      secondEffects = 0
    const first = wrapToolWithConstraint(
      {
        name: "first",
        run: async (_input: unknown, _context: unknown) => {
          firstEffects++
          return "first"
        },
      },
      () => {
        if (verdict === "approve") return { approve: true }
        if (verdict === "true") return true
        if (verdict === "throw") throw new Error("constraint changed")
        if (verdict === "off-contract") return false as unknown as true
        return "current constraint denied"
      },
      store,
      "/route",
    )
    const second = wrapToolWithApproval(
      {
        name: "second",
        run: async (_input: unknown, _context: unknown) => {
          secondEffects++
          return "second"
        },
      },
      store,
    )
    const State = Annotation.Root({ result: Annotation<unknown>() })
    const app = new StateGraph(State)
      .addNode("gates", async () => {
        const context = { signal: new AbortController().signal }
        await first.run({ body: "original" }, context)
        return { result: await second.run({ body: "second" }, context) }
      })
      .addEdge(START, "gates")
      .addEdge("gates", END)
      .compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: "two-gates" } }
    await app.invoke({}, config)
    verdict = changed
    const proof = createPermissionContinuationContext({
      runId: crypto.randomUUID(),
      resolve: async (request) =>
        request.rule.pattern === "first"
          ? JSON.stringify(request.protectedProposal) === JSON.stringify({ body: "original" })
          : undefined,
    })
    await app.invoke(new Command({ resume: "once" }), {
      configurable: { ...config.configurable, [PERMISSION_CONTINUATION_KEY]: proof },
    })
    expect(firstEffects).toBe(changed === "true" ? 1 : 0)
    expect(secondEffects).toBe(0)
    const pending = (await app.getState(config)).tasks.flatMap((task) => task.interrupts ?? [])
    expect(pending).toHaveLength(1)
    expect(pending[0]?.value).toMatchObject({ kind: "tool", detail: { toolName: "second" } })
  })
}
for (const early of ["inside-workspace", "bypass", "absent"] as const) {
  it(`correlates a changed actual path before the ${early} allowance`, async () => {
    const root = mkdtempSync(join(tmpdir(), "b4-core-path-gate-"))
    roots.push(root)
    let store: ReturnType<typeof createPermissionsStore> | undefined = createPermissionsStore({
      appRoot: root,
      config: undefined,
      mode: "interactive",
    })
    await store.load()
    let path = "/outside/original",
      effects = 0
    const State = Annotation.Root({ result: Annotation<unknown>() })
    const app = new StateGraph(State)
      .addNode("path", async () => {
        const result = await gatePathOp(store, "readFile", path, "/ws")
        if (result.allowed) effects++
        return { result }
      })
      .addEdge(START, "path")
      .addEdge("path", END)
      .compile({ checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: "path" } }
    await app.invoke({}, config)
    path = early === "inside-workspace" ? "/ws/changed" : "/outside/changed"
    if (early === "bypass")
      store = createPermissionsStore({ appRoot: root, config: undefined, mode: "bypass" })
    if (early === "absent") store = undefined
    const proof = createPermissionContinuationContext({
      runId: crypto.randomUUID(),
      resolve: async (request) =>
        JSON.stringify(request.protectedProposal) ===
        JSON.stringify({ operation: "readFile", path: "/outside/original" }),
    })
    await expect(
      app.invoke(new Command({ resume: "once" }), {
        configurable: { ...config.configurable, [PERMISSION_CONTINUATION_KEY]: proof },
      }),
    ).rejects.toThrow(/permission continuation/i)
    expect(effects).toBe(0)
  })
}
it("consumes a now-denied accepted tool slot without approving the next gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "b4-core-current-deny-"))
  roots.push(root)
  const store = createPermissionsStore({ appRoot: root, config: undefined, mode: "interactive" })
  await store.load()
  let effects = 0
  const first = wrapToolWithApproval(
    {
      name: "first",
      run: async (_input: unknown, _context: unknown) => {
        effects++
        return "first"
      },
    },
    store,
  )
  const second = wrapToolWithApproval(
    {
      name: "second",
      run: async (_input: unknown, _context: unknown) => {
        effects++
        return "second"
      },
    },
    store,
  )
  const State = Annotation.Root({ result: Annotation<unknown>() })
  const app = new StateGraph(State)
    .addNode("gates", async () => {
      const context = { signal: new AbortController().signal }
      await first.run({ body: "first" }, context)
      return { result: await second.run({ body: "second" }, context) }
    })
    .addEdge(START, "gates")
    .addEdge("gates", END)
    .compile({ checkpointer: new MemorySaver() })
  const config = { configurable: { thread_id: "denied-first" } }
  await app.invoke({}, config)
  const path = join(root, ".b4", "permissions.json")
  mkdirSync(join(root, ".b4"), { recursive: true })
  writeFileSync(path, JSON.stringify({ version: 1, allow: {}, deny: { tool: ["first"] } }))
  const proof = createPermissionContinuationContext({
    runId: crypto.randomUUID(),
    resolve: async (request) => (request.rule.pattern === "first" ? true : undefined),
  })
  await app.invoke(new Command({ resume: "once" }), {
    configurable: { ...config.configurable, [PERMISSION_CONTINUATION_KEY]: proof },
  })
  expect(effects).toBe(0)
  const pending = (await app.getState(config)).tasks.flatMap((task) => task.interrupts ?? [])
  expect(pending).toHaveLength(1)
  expect(pending[0]?.value).toMatchObject({ detail: { toolName: "second" } })
})

async function requiredGraph(extra = false) {
  configureApprovalGrants("required")
  const root = mkdtempSync(join(tmpdir(), "b4-core-required-context-"))
  roots.push(root)
  const permissions = createPermissionsStore({
    appRoot: root,
    config: undefined,
    mode: "interactive",
  })
  await permissions.load()
  const ledger = createMemoryInterruptGrantStore()
  const minter: ApprovalGrantMinter = {
    async mint({ interruptId, checkpointNs }) {
      const issued = await createApprovalGrant()
      await ledger.issue({
        threadId: "required",
        interruptId,
        checkpointNs,
        tokenHash: issued.tokenHash,
        issuedAt: new Date().toISOString(),
        expiresAt: null,
        consumedAt: null,
        consumedDecision: null,
        consumedBy: null,
        voidedAt: null,
      })
      return issued.grant
    },
  }
  let effects = 0
  const tool = wrapToolWithApproval(
    {
      name: "first",
      run: async (_input: unknown, _context: unknown) => {
        effects++
        return "first"
      },
    },
    permissions,
  )
  const later = wrapToolWithApproval(
    {
      name: "later",
      run: async (_input: unknown, _context: unknown) => {
        effects++
        return "later"
      },
    },
    permissions,
  )
  const State = Annotation.Root({ result: Annotation<unknown>() })
  const app = new StateGraph(State)
    .addNode("first", async () => ({
      result: await tool.run({ body: "original" }, { signal: new AbortController().signal }),
    }))
    .addNode("later", async () =>
      extra
        ? { result: await later.run({ body: "later" }, { signal: new AbortController().signal }) }
        : {},
    )
    .addEdge(START, "first")
    .addEdge("first", "later")
    .addEdge("later", END)
    .compile({ checkpointer: new MemorySaver() })
  await app.invoke(
    {},
    { configurable: { thread_id: "required", [APPROVAL_GRANT_MINTER_KEY]: minter } },
  )
  const records = await ledger.listForThread("required"),
    record = required(records[0])
  expect(records).toHaveLength(1)
  // This fixture supplies the core port's trusted accepted-binding proof. The
  // production runtime's all-grant transaction is exercised separately with
  // real SQLite/Postgres by protocol-permissions; this is the actual graph half.
  expect(
    (
      await ledger.consume({
        threadId: "required",
        interruptId: record.interruptId,
        decision: "always",
        at: new Date().toISOString(),
      })
    ).outcome,
  ).toBe("consumed")
  const rules = required(permissions.rememberedRules),
    intent = await rules.prepare("required-accepted", [{ tool: "tool", pattern: "first" }])
  await rules.apply(intent)
  const proof = createPermissionContinuationContext({
    runId: crypto.randomUUID(),
    resolve: async (request) => {
      if (request.rule.pattern !== "first") return undefined
      const accepted = await ledger.get("required", record.interruptId)
      return (
        accepted?.consumedDecision === "always" &&
        request.checkpointNs === record.checkpointNs &&
        JSON.stringify(request.protectedProposal) === JSON.stringify({ body: "original" })
      )
    },
  })
  return { app, ledger, minter, proof, effects: () => effects }
}
it("resumes a proven required-mode binding without a fresh minter or second legacy grant", async () => {
  const f = await requiredGraph()
  await f.app.invoke(new Command({ resume: "always" }), {
    configurable: { thread_id: "required", [PERMISSION_CONTINUATION_KEY]: f.proof },
  })
  expect(f.effects()).toBe(1)
  expect(await f.ledger.listForThread("required")).toHaveLength(1)
})
it("still requires and uses a real minter for an unmatched required-mode gate", async () => {
  const f = await requiredGraph(true)
  await expect(
    f.app.invoke(new Command({ resume: "always" }), {
      configurable: { thread_id: "required", [PERMISSION_CONTINUATION_KEY]: f.proof },
    }),
  ).rejects.toBeInstanceOf(MissingApprovalGrantMinterError)
  expect(f.effects()).toBe(1)
  expect(await f.ledger.listForThread("required")).toHaveLength(1)
  const g = await requiredGraph(true)
  await g.app.invoke(new Command({ resume: "always" }), {
    configurable: {
      thread_id: "required",
      [PERMISSION_CONTINUATION_KEY]: g.proof,
      [APPROVAL_GRANT_MINTER_KEY]: g.minter,
    },
  })
  expect(g.effects()).toBe(1)
  expect(await g.ledger.listForThread("required")).toHaveLength(2)
})
