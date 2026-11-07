import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { wrapToolWithConstraint } from "@b4run/core"
import { createPermissionsStore } from "@b4run/permissions/node"
import { expect, it } from "vitest"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import {
  createPermissionService,
  type PermissionProposal,
  parkPermissions,
} from "../src/lib/runtime/permissions.ts"
import { sharedPermissionFixtures } from "./fixtures/protocol-admission.ts"

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing required test fixture value")
  return value
}

const fixtures = sharedPermissionFixtures()

async function setup(
  count = 2,
  options: {
    grants?: "off" | "optional" | "required"
    parkGrants?: "off" | "optional" | "required"
    expiresAt?: string
    allowAlways?: boolean
    rules?: boolean
    constraint?: boolean
    agentId?: string
    onRuleResolve?: () => void
  } = {},
) {
  const f = await fixtures.create()
  const accepted = await f.admit()
  let rules = createPermissionsStore({
    appRoot: f.directory,
    config: undefined,
    mode: "interactive",
  })
  let ruleResolutions = 0
  const serviceOptions = {
    ...f.authority,
    ...(options.rules
      ? {
          resolvePermissions: async () => {
            ruleResolutions++
            options.onRuleResolve?.()
            return rules
          },
        }
      : {}),
  }
  const proposals: PermissionProposal[] = Array.from({ length: count }, (_, i) => ({
    interruptId: `prompt-${i}`,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    namespace: i === 0 ? [] : ["delegate", "child"],
    request: { kind: "tool", detail: { toolName: `effect-${i}`, suggestedPattern: `effect-${i}` } },
    protectedProposal: { tool: `effect-${i}`, args: { value: i } },
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    ...(options.allowAlways !== undefined ? { allowAlways: options.allowAlways } : {}),
  }))
  let fail: "afterConsume" | "afterRuleApply" | "beforeCommit" | "afterCommit" | undefined
  const service = createPermissionService({
    ...serviceOptions,
    grants: options.grants ?? "required",
    failpoint(point) {
      if (point === fail) {
        fail = undefined
        throw new Error("injected-after-first-consume")
      }
    },
  })
  let effects = 0
  const host = createExecutionHost({
    storage: f.storage,
    permissions: service,
    async invoke({ run, store, signal }) {
      if (run.run.run_id === accepted.runId)
        await store.transaction((tx) =>
          parkPermissions(
            tx,
            run.run.run_id,
            proposals,
            options.parkGrants ?? options.grants ?? "required",
          ),
        )
      else {
        const snapshot = await store.snapshot()
        const dispatch = snapshot.inbox.find(
          (entry) => entry.kind === "dispatch" && entry.runId === run.run.run_id,
        )
        const responses =
          (dispatch?.payload as { responses?: { response: string }[] } | undefined)?.responses ?? []
        if (responses[0]?.response !== "deny") {
          const tool = wrapToolWithConstraint(
            {
              name: "effect-0",
              run: async (_input: unknown, _context: unknown) => {
                effects++
                return "effect"
              },
            },
            () => (options.constraint ? "constraint denies" : true),
            rules,
            "/chat",
          )
          await tool.run({}, { signal, threadId: f.directory })
        }
      }
      return {}
    },
  })
  f.ownHost(host)
  await host.tick()
  await host.idle()
  const paused = await f.snapshot(accepted.threadId)
  expect(paused.thread?.pausedGeneration).toEqual(expect.any(String))
  expect(paused.pending).toHaveLength(count)
  const answers = paused.pending.map((entry) => ({
    namespace: entry.namespace,
    interruptId: entry.input.data.interruptId,
    response: {
      decision: "once",
      ...(entry.input.data.b4.grant ? { grant: entry.input.data.b4.grant } : {}),
    },
  }))
  const command = (responses = answers, token = crypto.randomUUID()) => ({
    id: 1,
    method: "input.respond",
    params: {
      ...(count === 1 ? responses[0] : { responses }),
      metadata: {
        b4: {
          v: 1,
          submissionId: token,
          expected: {
            generation: paused.scope.generation,
            runId: accepted.runId,
            pausedGeneration: paused.thread?.pausedGeneration,
          },
        },
      },
    },
  })
  return {
    f,
    host,
    accepted,
    paused,
    answers,
    command,
    service,
    rules: () => rules,
    ruleResolutionCount: () => ruleResolutions,
    ruleDomain(appRoot = f.directory) {
      rules = createPermissionsStore({ appRoot, config: undefined, mode: "interactive" })
    },
    respond: (body: unknown = command()) =>
      f.trackWork("permission", () =>
        service.respond(f.request(), accepted.threadId, accepted.runId, body),
      ),
    effects: () => effects,
    failBeforeCommit() {
      fail = "beforeCommit"
    },
    loseAcknowledgement() {
      fail = "afterCommit"
    },
    failAfterRuleApply() {
      fail = "afterRuleApply"
    },
    failAfterConsume() {
      fail = "afterConsume"
    },
  }
}
it("accepts a full nested batch once and recovers its exact receipt before the consumed pause", async () => {
  const f = await setup()
  const command = f.command()
  const result = await f.respond(command)
  const retried = await f.respond(command)
  expect(retried.runId).toBe(result.runId)
  expect(retried.responseMeta.b4.receipt.replayed).toBe(true)
  const snapshot = await f.f.snapshot(f.accepted.threadId)
  expect(snapshot.runs).toHaveLength(2)
  expect(snapshot.grants.every((grant) => grant.consumedByRunId === result.runId)).toBe(true)
  expect(snapshot.pending.every((entry) => entry.disposition === "answered")).toBe(true)
  expect(snapshot.runs.find((run) => run.run.run_id === result.runId)?.metadata).toMatchObject({
    turnId: f.accepted.runId,
    previousRunId: f.accepted.runId,
    phase: "accepted",
  })
  await f.host.tick()
  await f.host.idle()
  expect(f.effects()).toBe(1)
})
it("rolls back the first consumed grant and every continuation fact on a later failure", async () => {
  const f = await setup()
  f.failAfterConsume()
  await expect(f.respond()).rejects.toThrow("injected-after-first-consume")
  const snapshot = await f.f.snapshot(f.accepted.threadId)
  expect(snapshot.grants.every((grant) => grant.consumedByRunId === null)).toBe(true)
  expect(snapshot.runs).toHaveLength(1)
  expect(snapshot.receipts).toHaveLength(1)
  expect(snapshot.inbox.filter((entry) => entry.kind === "dispatch")).toHaveLength(1)
  expect(snapshot.pending.every((entry) => entry.disposition === "pending")).toBe(true)
  expect(snapshot.thread?.pausedGeneration).toBe(f.paused.thread?.pausedGeneration)
  await f.host.tick()
  await f.host.idle()
  expect(f.effects()).toBe(0)
})

it("accepts InputRespondOne and treats batch answer order as a set on exact retry", async () => {
  const one = await setup(1)
  const a = await one.respond()
  expect(a.runId).not.toBe(one.accepted.runId)
  await one.host.tick()
  await one.host.idle()
  expect(one.effects()).toBe(1)
  const many = await setup()
  const command = many.command()
  const first = await many.respond(command)
  const retry = {
    ...command,
    id: 7,
    params: { ...command.params, responses: [...many.answers].reverse() },
  }
  expect((await many.respond(retry)).runId).toBe(first.runId)
})
for (const kind of ["duplicate", "missing", "foreign", "namespace"] as const) {
  it(`rejects ${kind} responses before consuming any grant`, async () => {
    const f = await setup()
    const answers = [...f.answers]
    if (kind === "duplicate") answers[1] = required(answers[0])
    if (kind === "missing") answers.pop()
    if (kind === "foreign") answers[1] = { ...required(answers[1]), interruptId: "foreign" }
    if (kind === "namespace") answers[1] = { ...required(answers[1]), namespace: ["other"] }
    await expect(f.respond(f.command(answers))).rejects.toMatchObject({
      code: "incomplete_responses",
    })
    expect(
      (await f.f.snapshot(f.accepted.threadId)).grants.every((g) => g.consumedByRunId === null),
    ).toBe(true)
    await f.host.tick()
    await f.host.idle()
    expect(f.effects()).toBe(0)
  })
}
it("rejects malformed responses, protected edits, and changed proposal bindings without consumption", async () => {
  const f = await setup()
  const command = f.command()
  await expect(
    f.respond({ ...command, params: { ...command.params, update: { args: { value: 99 } } } }),
  ).rejects.toMatchObject({ code: "approval_changed" })
  await expect(
    f.respond({
      ...command,
      params: {
        ...command.params,
        responses: f.answers.map((a) => ({ ...a, response: { ...a.response, forged: true } })),
      },
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" })
  const store = await f.f.store(f.accepted.threadId)
  const original = (await store.snapshot()).pending.find(
    (row) => row.input.data.interruptId === "prompt-1",
  )
  if (!original?.proposal) throw new Error("Missing protected proposal")
  const originalProposal = original.proposal
  await store.transaction((tx) =>
    tx.pending.put({ ...original, proposal: { ...originalProposal, value: { changed: true } } }),
  )
  await expect(f.respond(command)).rejects.toMatchObject({ code: "approval_changed" })
  await store.transaction((tx) => tx.pending.put(original))
  await (await f.f.store(f.accepted.threadId)).transaction(async (tx) => {
    const pending = (await tx.pending.list()).find(
      (row) => row.input.data.interruptId === "prompt-1",
    )
    if (!pending) throw new Error("Missing pending prompt")
    await tx.pending.put({ ...pending, disposition: "retired" })
    await tx.pending.put({
      ...pending,
      input: {
        ...pending.input,
        data: {
          ...pending.input.data,
          b4: { ...pending.input.data.b4, proposalHash: "changed" },
        },
      },
    })
  })
  await expect(f.respond(command)).rejects.toMatchObject({ code: "approval_changed" })
  expect(
    (await f.f.snapshot(f.accepted.threadId)).grants.every((g) => g.consumedByRunId === null),
  ).toBe(true)
})
it("authorizes current caller and original Agent before returning accepted retry", async () => {
  const f = await setup()
  const command = f.command()
  await f.respond(command)
  f.f.defaultAgent("/changed#agent")
  f.f.parser(() => {
    throw new Error("must not parse retry")
  })
  expect((await f.respond(command)).responseMeta.b4.receipt.replayed).toBe(true)
  f.f.deny()
  await expect(f.respond(command)).rejects.toMatchObject({ code: "not_found" })
})
it("rejects a foreign grant and a changed token payload without leaking grant material", async () => {
  const f = await setup()
  const g = await setup()
  await expect(
    f.respond(
      f.command(f.answers.map((a, i) => ({ ...a, response: required(g.answers[i]).response }))),
    ),
  ).rejects.toMatchObject({ code: "grant_invalid", message: "Invalid grant" })
  const command = f.command()
  await f.respond(command)
  await expect(
    f.respond({
      ...command,
      params: {
        ...command.params,
        responses: f.answers.map((a) => ({ ...a, response: { ...a.response, decision: "deny" } })),
      },
    }),
  ).rejects.toMatchObject({ code: "submission_conflict" })
})
it("serializes concurrent complete answers and concurrent exact retries", async () => {
  const f = await setup()
  const command = f.command()
  const [a, b] = await Promise.all([f.respond(command), f.respond(command)])
  expect(a.runId).toBe(b.runId)
  await f.host.tick()
  await f.host.idle()
  expect(f.effects()).toBe(1)
  const g = await setup()
  const results = await Promise.allSettled([g.respond(), g.respond()])
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
  expect((await g.f.snapshot(g.accepted.threadId)).runs).toHaveLength(2)
})
for (const grants of ["off", "optional", "required"] as const) {
  it(`honors ${grants} mode with prompts minted without grants`, async () => {
    const f = await setup(1, { grants, parkGrants: "off" })
    if (grants === "required")
      await expect(f.respond()).rejects.toMatchObject({ code: "grant_invalid" })
    else await f.respond()
  })
}
it("requires an existing optional grant and coerces unavailable Always to Once", async () => {
  const f = await setup(1, { grants: "optional", allowAlways: false })
  await expect(
    f.respond(f.command(f.answers.map((a) => ({ ...a, response: { decision: "once" } })))),
  ).rejects.toMatchObject({ code: "grant_invalid" })
  await f.respond(
    f.command(f.answers.map((a) => ({ ...a, response: { ...a.response, decision: "always" } }))),
  )
  expect((await f.f.snapshot(f.accepted.threadId)).pending[0]?.decision).toBe("once")
})
it("refuses expired positives but accepts authentic negative abandonment", async () => {
  const f = await setup(1, { expiresAt: "2000-01-01T00:00:00.000Z" })
  expect(f.paused.pending[0]?.input.data.b4.status).toBe("expired")
  await expect(f.respond()).rejects.toMatchObject({ code: "grant_expired" })
  const result = await f.respond(
    f.command(f.answers.map((a) => ({ ...a, response: { ...a.response, decision: "deny" } }))),
  )
  expect(result.runId).not.toBe(f.accepted.runId)
  expect((await f.f.snapshot(f.accepted.threadId)).pending[0]?.input.data.b4.status).toBe(
    "abandoned",
  )
})

it("commits remembered-rule intents with acceptance and refuses unsupported custom Always", async () => {
  const unsupported = await setup(1)
  await expect(
    unsupported.respond(
      unsupported.command(
        unsupported.answers.map((a) => ({ ...a, response: { ...a.response, decision: "always" } })),
      ),
    ),
  ).rejects.toMatchObject({ code: "not_supported" })
  const f = await setup(1, { rules: true })
  const result = await f.respond(
    f.command(f.answers.map((a) => ({ ...a, response: { ...a.response, decision: "always" } }))),
  )
  const snapshot = await f.f.snapshot(f.accepted.threadId)
  expect(
    snapshot.inbox.filter((entry) => entry.kind === "rule_intent" && entry.runId === result.runId),
  ).toHaveLength(1)
  expect(f.rules().match("tool", "effect-0")).toBe("unknown")
})

it("applies an Always intent through the same configured domain after recreating the rule-store instance", async () => {
  const f = await setup(1, { rules: true })
  const result = await f.respond(
    f.command(f.answers.map((a) => ({ ...a, response: { ...a.response, decision: "always" } }))),
  )
  f.ruleDomain()
  await f.host.tick()
  await f.host.idle()
  expect(f.rules().match("tool", "effect-0")).toBe("allow")
  expect(f.effects()).toBe(1)
  expect(
    (await f.f.snapshot(f.accepted.threadId)).inbox.find(
      (entry) => entry.kind === "rule_intent" && entry.runId === result.runId,
    )?.status,
  ).toBe("applied")
})
it("defers protected execution on actual remembered-rule I/O failure, then retries the accepted Run", async () => {
  const f = await setup(1, { rules: true })
  const result = await f.respond(
    f.command(f.answers.map((a) => ({ ...a, response: { ...a.response, decision: "always" } }))),
  )
  const path = join(f.f.directory, ".b4", "permissions.json")
  renameSync(path, `${path}.saved`)
  mkdirSync(path)
  await expect(f.host.tick()).rejects.toThrow()
  const snapshot = await f.f.snapshot(f.accepted.threadId)
  expect(snapshot.runs.find((row) => row.run.run_id === result.runId)?.metadata).toMatchObject({
    phase: "accepted",
  })
  expect(
    snapshot.runs.find((row) => row.run.run_id === result.runId)?.metadata.startedAt,
  ).toBeUndefined()
  expect(f.effects()).toBe(0)
  rmSync(path, { recursive: true })
  renameSync(`${path}.saved`, path)
  await f.host.tick()
  await f.host.idle()
  expect(f.effects()).toBe(1)
})

it("does not replay an applied intent after later user edits and lost rule acknowledgement", async () => {
  const f = await setup(1, { rules: true })
  const command = f.command(
    f.answers.map((a) => ({ ...a, response: { ...a.response, decision: "always" } })),
  )
  const result = await f.respond(command)
  f.failAfterRuleApply()
  await expect(f.host.tick()).rejects.toThrow("injected-after-first-consume")
  const path = join(f.f.directory, ".b4", "permissions.json"),
    file = JSON.parse(readFileSync(path, "utf8"))
  file.allow = {}
  writeFileSync(path, JSON.stringify(file))
  expect((await f.respond(command)).runId).toBe(result.runId)
  await f.host.tick()
  await f.host.idle()
  expect(f.rules().match("tool", "effect-0")).toBe("unknown")
  expect(f.effects()).toBe(0)
  const snapshot = await f.f.snapshot(f.accepted.threadId)
  expect(snapshot.runs.find((row) => row.run.run_id === result.runId)?.metadata).toMatchObject({
    phase: "settled",
    reason: "execution_error",
    effectsUncertain: false,
  })
  expect(
    snapshot.runs.find((row) => row.run.run_id === result.runId)?.metadata.startedAt,
  ).toBeUndefined()
  expect(snapshot.inbox.find((entry) => entry.kind === "rule_intent")?.status).toBe("not_applied")
})
it("refuses a mismatched configured rule domain even when the runtime inbox says applied", async () => {
  const f = await setup(1, { rules: true }),
    other = await setup(1, { rules: true })
  const result = await f.respond(
    f.command(f.answers.map((a) => ({ ...a, response: { ...a.response, decision: "always" } }))),
  )
  await (await f.f.store(f.accepted.threadId)).transaction(async (tx) => {
    for (const entry of await tx.inbox.list())
      if (entry.kind === "rule_intent") await tx.inbox.put({ ...entry, status: "applied" })
  })
  f.ruleDomain(other.f.directory)
  await f.host.tick()
  await f.host.idle()
  expect(f.effects()).toBe(0)
  expect(f.rules().match("tool", "effect-0")).toBe("unknown")
  expect(
    (await f.f.snapshot(f.accepted.threadId)).runs.find((row) => row.run.run_id === result.runId)
      ?.metadata.reason,
  ).toBe("execution_error")
})
it("keeps current configured deny and actual tool constraints above remembered Always", async () => {
  const f = await setup(1, { rules: true })
  await f.respond(
    f.command(f.answers.map((a) => ({ ...a, response: { ...a.response, decision: "always" } }))),
  )
  const path = join(f.f.directory, ".b4", "permissions.json"),
    file = JSON.parse(readFileSync(path, "utf8"))
  file.deny = { tool: ["effect-0"] }
  writeFileSync(path, JSON.stringify(file))
  await f.host.tick()
  await f.host.idle()
  expect(f.effects()).toBe(0)
  const g = await setup(1, { rules: true, constraint: true })
  await g.respond(
    g.command(g.answers.map((a) => ({ ...a, response: { ...a.response, decision: "always" } }))),
  )
  await g.host.tick()
  await g.host.idle()
  expect(g.rules().match("tool", "effect-0")).toBe("allow")
  expect(g.effects()).toBe(0)
})
it("closes the predecessor's current Run view in its retained result and removes spent grant disclosure", async () => {
  const f = await setup(1)
  await f.respond()
  const snapshot = await f.f.snapshot(f.accepted.threadId)
  const previous = snapshot.runs.find((row) => row.run.run_id === f.accepted.runId)
  expect(previous?.run.status).toBe("interrupted")
  expect(previous?.metadata).toMatchObject({ reason: "permission", continuation: "closed" })
  expect(previous?.result?.run?.metadata?.b4).toMatchObject({
    reason: "permission",
    continuation: "closed",
  })
  expect(snapshot.pending[0]?.input.data.b4.grant).toBeUndefined()
  const journal = await (await f.f.store(f.accepted.threadId)).transaction((tx) =>
    tx.journal.read(0),
  )
  expect(journal.some((row) => row.event.method === "input.requested")).toBe(true)
  expect(JSON.stringify(journal)).not.toContain(f.answers[0]?.response.grant)
})

it("reauthorizes the server-selected nested Agent before new answers and exact receipt retries", async () => {
  const f = await setup(1, { agentId: "/other#agent" })
  f.f.removeAgent("/other#agent")
  await expect(f.respond()).rejects.toMatchObject({ code: "not_found" })
  expect(
    (await f.f.snapshot(f.accepted.threadId)).grants.every((row) => row.consumedByRunId === null),
  ).toBe(true)
  const g = await setup(1, { agentId: "/other#agent" }),
    command = g.command()
  const resumed = await g.respond(command)
  g.f.removeAgent("/other#agent")
  await expect(g.respond(command)).rejects.toMatchObject({ code: "not_found" })
  const lookup = await g.f.lookup(command.params.metadata.b4.submissionId)
  const search = await g.f.search({}, { thread_id: g.accepted.threadId })
  expect({
    lookup,
    visibleContinuation: search.filter((row) => row.run_id === resumed.runId),
  }).toEqual({ lookup: [], visibleContinuation: [] })
})
it("fails a permanently conflicting remembered intent without starting or repeatedly deferring it", async () => {
  const f = await setup(1, { rules: true })
  const accepted = await f.respond(
    f.command(
      f.answers.map((answer) => ({
        ...answer,
        response: { ...answer.response, decision: "always" },
      })),
    ),
  )
  const snapshot = await f.f.snapshot(f.accepted.threadId)
  const entry = snapshot.inbox.find((entry) => entry.kind === "rule_intent")
  if (!entry) throw new Error("Missing durable rule intent")
  const intent = (entry.payload as { intent: { operationId: string } }).intent
  const coordinator = f.rules().rememberedRules
  if (!coordinator) throw new Error("Missing real rule coordinator")
  const conflicting = await coordinator.prepare(intent.operationId, [
    { tool: "tool", pattern: "other" },
  ])
  await coordinator.apply(conflicting)
  await f.host.tick()
  await f.host.idle()
  await f.host.tick()
  await f.host.idle()
  expect(f.effects()).toBe(0)
  const run = (await f.f.snapshot(f.accepted.threadId)).runs.find(
    (row) => row.run.run_id === accepted.runId,
  )
  expect(run?.metadata).toMatchObject({
    phase: "settled",
    reason: "execution_error",
    effectsUncertain: false,
  })
  expect(run?.metadata.startedAt).toBeUndefined()
  const dispatch = (await f.f.snapshot(f.accepted.threadId)).inbox.find(
    (entry) => entry.kind === "dispatch" && entry.runId === accepted.runId,
  )
  expect(dispatch?.status).toBe("not_applied")
})
it("honors a current deny for a Once continuation before protected invocation", async () => {
  const f = await setup(1, { rules: true })
  await f.respond()
  mkdirSync(join(f.f.directory, ".b4"), { recursive: true })
  writeFileSync(
    join(f.f.directory, ".b4", "permissions.json"),
    JSON.stringify({ version: 1, allow: {}, deny: { tool: ["effect-0"] } }),
  )
  await f.host.tick()
  await f.host.idle()
  expect(f.effects()).toBe(0)
})

it("rolls back durable rule intents with a failed acceptance and reconciles a lost acknowledgement", async () => {
  const f = await setup(1, { rules: true }),
    command = f.command(
      f.answers.map((answer) => ({
        ...answer,
        response: { ...answer.response, decision: "always" },
      })),
    )
  f.failBeforeCommit()
  await expect(f.respond(command)).rejects.toThrow("injected-after-first-consume")
  let snapshot = await f.f.snapshot(f.accepted.threadId)
  expect(snapshot.runs).toHaveLength(1)
  expect(snapshot.inbox.filter((entry) => entry.kind === "rule_intent")).toHaveLength(0)
  expect(snapshot.grants.every((row) => row.consumedByRunId === null)).toBe(true)
  expect(f.rules().match("tool", "effect-0")).toBe("unknown")
  f.loseAcknowledgement()
  await expect(f.respond(command)).rejects.toThrow("injected-after-first-consume")
  const replay = await f.respond(command)
  expect(replay.responseMeta.b4.receipt.replayed).toBe(true)
  snapshot = await f.f.snapshot(f.accepted.threadId)
  expect(snapshot.runs).toHaveLength(2)
  expect(snapshot.inbox.filter((entry) => entry.kind === "rule_intent")).toHaveLength(1)
  await f.host.tick()
  await f.host.idle()
  expect(f.effects()).toBe(1)
})
it("authorizes the original root before any external nested Always preparation", async () => {
  const f = await setup(2, { rules: true, agentId: "/other#agent" })
  const path = join(f.f.directory, ".b4", "permissions.json")
  const gitignore = join(f.f.directory, ".gitignore")
  expect(existsSync(path)).toBe(false)
  expect(existsSync(gitignore)).toBe(false)
  f.f.removeAgent("/chat#agent")
  await expect(
    f.respond(
      f.command(
        f.answers.map((answer) => ({
          ...answer,
          response: { ...answer.response, decision: "always" },
        })),
      ),
    ),
  ).rejects.toMatchObject({ code: "not_found" })
  const snapshot = await f.f.snapshot(f.accepted.threadId)
  expect({
    resolutions: f.ruleResolutionCount(),
    ruleFile: existsSync(path),
    gitignore: existsSync(gitignore),
  }).toEqual({ resolutions: 0, ruleFile: false, gitignore: false })
  expect(snapshot.grants).toEqual(f.paused.grants)
  expect(snapshot.pending).toEqual(f.paused.pending)
  expect(snapshot.runs).toHaveLength(1)
  expect(snapshot.receipts).toHaveLength(1)
  expect(snapshot.inbox.some((row) => row.kind === "rule_intent")).toBe(false)
  await f.host.tick()
  await f.host.idle()
  expect(f.effects()).toBe(0)
})
for (const agentId of ["/chat#agent", "/other#agent"]) {
  it(`rechecks ${agentId} inside acceptance after authorized rule preparation`, async () => {
    let revoke = () => {}
    const f = await setup(2, {
      rules: true,
      agentId: "/other#agent",
      onRuleResolve: () => revoke(),
    })
    revoke = () => f.f.removeAgent(agentId)
    await expect(
      f.respond(
        f.command(
          f.answers.map((answer) => ({
            ...answer,
            response: { ...answer.response, decision: "always" },
          })),
        ),
      ),
    ).rejects.toMatchObject({ code: "not_found" })
    expect(f.ruleResolutionCount()).toBeGreaterThan(0)
    const snapshot = await f.f.snapshot(f.accepted.threadId)
    expect(snapshot.grants).toEqual(f.paused.grants)
    expect(snapshot.pending).toEqual(f.paused.pending)
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.receipts).toHaveLength(1)
    await f.host.tick()
    await f.host.idle()
    expect(f.effects()).toBe(0)
  })
}
it("groups a full nested Always batch in one original configured rule domain", async () => {
  const f = await setup(2, { rules: true, agentId: "/other#agent" })
  const command = f.command(
    f.answers.map((answer) => ({
      ...answer,
      response: { ...answer.response, decision: "always" },
    })),
  )
  const result = await f.respond(command)
  let retryResolutions = 0
  const retry = createPermissionService({
    ...f.f.authority,
    grants: "required",
    resolvePermissions: async () => {
      retryResolutions++
      throw new Error("Exact retry must reconcile before preparation")
    },
  })
  const replay = await f.f.trackWork("permission-retry", () =>
    retry.respond(f.f.request(), f.accepted.threadId, f.accepted.runId, command),
  )
  expect(replay.runId).toBe(result.runId)
  expect(replay.responseMeta.b4.receipt.replayed).toBe(true)
  expect(retryResolutions).toBe(0)
  const snapshot = await f.f.snapshot(f.accepted.threadId)
  expect(
    snapshot.inbox.filter((entry) => entry.kind === "rule_intent" && entry.runId === result.runId),
  ).toHaveLength(1)
  await f.host.tick()
  await f.host.idle()
  expect(f.rules().match("tool", "effect-0")).toBe("allow")
  expect(f.rules().match("tool", "effect-1")).toBe("allow")
  expect(f.effects()).toBe(1)
})
for (const field of ["generation", "runId", "pausedGeneration"] as const) {
  it(`rejects a changed expected ${field} without consuming any grant`, async () => {
    const f = await setup(),
      command = f.command()
    command.params.metadata.b4.expected[field] = crypto.randomUUID()
    await expect(f.respond(command)).rejects.toMatchObject({ code: "stale_generation" })
    expect(
      (await f.f.snapshot(f.accepted.threadId)).grants.every(
        (grant) => grant.consumedByRunId === null,
      ),
    ).toBe(true)
    await f.host.tick()
    await f.host.idle()
    expect(f.effects()).toBe(0)
  })
}

it("refuses an exhausted rule revision as a permanent intent failure without starting", async () => {
  const f = await setup(1, { rules: true })
  const accepted = await f.respond(
    f.command(
      f.answers.map((answer) => ({
        ...answer,
        response: { ...answer.response, decision: "always" },
      })),
    ),
  )
  const path = join(f.f.directory, ".b4", "permissions.json"),
    file = JSON.parse(readFileSync(path, "utf8"))
  file._b4RuleCoordinator.revision = Number.MAX_SAFE_INTEGER
  writeFileSync(path, JSON.stringify(file))
  await f.host.tick()
  await f.host.idle()
  const run = (await f.f.snapshot(f.accepted.threadId)).runs.find(
    (row) => row.run.run_id === accepted.runId,
  )
  expect(run?.metadata).toMatchObject({
    phase: "settled",
    reason: "execution_error",
    effectsUncertain: false,
  })
  expect(run?.metadata.startedAt).toBeUndefined()
  expect(f.effects()).toBe(0)
})
