import { streamAgent } from "@b4run/langchain"
import { agentBackendAdapter } from "@b4run/langchain/internal/runtime"
import { agent } from "@b4run/sdk"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { afterEach, expect, it, vi } from "vitest"
import { createRuntimeCheckpointSaver } from "../src/lib/runtime/checkpoint-saver.ts"
import { createExecutionHost } from "../src/lib/runtime/executor.ts"
import { createActiveInputBoundary, createInputService } from "../src/lib/runtime/inputs.ts"
import { body, fixture } from "./fixtures/protocol-admission.ts"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.doUnmock("@langchain/openai")
})
it("keeps bounded FIFO inputs and duplicate token identity on the exact accepted Run", async () => {
  const f = await fixture()
  cleanup.push(() => f.close())
  const accepted = await f.admit(body({ on_completion: "keep" }))
  const service = createInputService({
    ...f.authority,
    resolveTarget: async ({ run }) => ({
      adapter: agentBackendAdapter,
      agentId: run.run.agent_id!,
      namespaceGeneration: run.run.run_id,
      systemInjection: false,
    }),
    limits: { entries: 2, bytes: 1048576, textBytes: 65536 },
  })
  const params = (text: string, token = crypto.randomUUID()) => ({
    namespace: [],
    message: { role: "user", content: text, b4: { v: 1, submissionId: token } },
  })
  const one = params("first")
  const first = await service.inject(f.request(), accepted.threadId, accepted.runId, one)
  const repeated = await service.inject(f.request(), accepted.threadId, accepted.runId, one)
  expect(repeated.b4.receipt).toEqual({ ...first.b4.receipt, replayed: true })
  await service.inject(f.request(), accepted.threadId, accepted.runId, params("second"))
  await expect(
    service.inject(f.request(), accepted.threadId, accepted.runId, params("third")),
  ).rejects.toMatchObject({ code: "capacity_exceeded" })
  await expect(
    service.inject(f.request(), accepted.threadId, accepted.runId, {
      ...one,
      message: { ...one.message, content: "changed" },
    }),
  ).rejects.toMatchObject({ code: "submission_conflict" })
  const snapshot = await f.snapshot(accepted.threadId)
  const inputs = snapshot.inbox
    .filter((entry) => entry.kind === "inject")
    .sort(
      (left, right) =>
        (left.payload as { order: number }).order - (right.payload as { order: number }).order,
    )
  expect(
    inputs.map((entry) => (entry.payload as { message: { content: string } }).message.content),
  ).toEqual(["first", "second"])
  expect(snapshot.runs).toHaveLength(1)
}, 30_000)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
it.each(["user", "system"] as const)(
  "commits FIFO %s checkpoints and applied receipts before the actual next model after model/tool work",
  async (role) => {
    const f = await fixture()
    cleanup.push(() => f.close())
    const accepted = await f.admit(body({ on_completion: "keep" }))
    const modelEntered = deferred(),
      releaseModel = deferred(),
      toolEntered = deferred(),
      releaseTool = deferred()
    cleanup.push(async () => {
      releaseModel.resolve()
      releaseTool.resolve()
    })
    const seen: string[][] = []
    let active = 0,
      maximum = 0
    const tokens = [crypto.randomUUID(), crypto.randomUUID()]
    class ControlledModel extends BaseChatModel {
      constructor(_options: Record<string, unknown>) {
        super({})
      }
      _llmType() {
        return "durable-boundary"
      }
      bindTools() {
        return this
      }
      async _generate(messages: BaseMessage[]): Promise<ChatResult> {
        maximum = Math.max(maximum, ++active)
        seen.push(messages.map((message) => String(message.content)))
        if (seen.length === 1) {
          modelEntered.resolve()
          await releaseModel.promise
        } else
          for (const token of tokens)
            expect((await f.lookup(token))[0]?.metadata.b4).toMatchObject({
              lookup: { receipt: { disposition: "applied" } },
            })
        const message =
          seen.length === 1
            ? new AIMessage({
                content: "",
                tool_calls: [{ id: "inspect-1", name: "inspect", args: {} }],
              })
            : new AIMessage("done")
        active--
        return { generations: [{ text: "", message }] }
      }
    }
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: ControlledModel }))
    let resolutions = 0,
      privilegeChecks = 0,
      freshResolutionAllowed = true,
      privileged = true
    const service = createInputService({
      ...f.authority,
      authorizeSystemInput: async () => {
        privilegeChecks++
        return privileged
      },
      resolveTarget: async ({ run }) => {
        resolutions++
        if (!freshResolutionAllowed) throw new Error("Retry attempted fresh target preparation")
        return {
          adapter: agentBackendAdapter,
          agentId: run.run.agent_id!,
          namespaceGeneration: run.run.run_id,
          systemInjection: privileged,
        }
      },
    })
    let invocationError: unknown
    const host = createExecutionHost({
      storage: f.storage,
      async invoke({ store, run, signal }) {
        const boundary = createActiveInputBoundary({
          store,
          runId: run.run.run_id,
          namespace: [],
          namespaceGeneration: run.run.run_id,
        })
        const checkpointer = createRuntimeCheckpointSaver({
          store,
          runId: run.run.run_id,
          namespace: [],
          commitInputs: boundary.commitInputs,
        })
        try {
          for await (const _chunk of streamAgent({
            checkpointer,
            activeInput: boundary.activeInput,
            entry: agent({ model: "gpt-5-mini", systemPrompt: "Durable." }),
            input: run.run.input,
            routeParamNames: [],
            signal,
            threadId: accepted.threadId,
            tools: [
              {
                name: "inspect",
                description: "Inspect.",
                run: async () => {
                  toolEntered.resolve()
                  await releaseTool.promise
                  return "observed"
                },
              },
            ],
          })) {
            /* drain the actual graph and all saver writes */
          }
        } catch (error) {
          invocationError = error
          throw error
        }
        return {}
      },
    })
    cleanup.push(async () => {
      releaseModel.resolve()
      releaseTool.resolve()
      await host.close()
    })
    await host.tick()
    await Promise.race([
      modelEntered.promise,
      host.idle().then(() => {
        throw new Error("Execution settled before entering the model")
      }),
    ])
    const inject = (index: number) =>
      service.inject(f.request(), accepted.threadId, accepted.runId, {
        namespace: [],
        message: { role, content: `steering-${index}`, b4: { v: 1, submissionId: tokens[index] } },
      })
    expect((await inject(0)).b4.receipt.disposition).toBe("accepted")
    expect(seen).toHaveLength(1)
    releaseModel.resolve()
    await Promise.race([
      toolEntered.promise,
      host.idle().then(() => {
        throw new Error("Execution settled before entering the tool")
      }),
    ])
    expect((await inject(1)).b4.receipt.disposition).toBe("accepted")
    releaseTool.resolve()
    await host.idle()
    expect(invocationError).toBeUndefined()
    expect((await f.snapshot(accepted.threadId)).runs[0]?.run.status).toBe("success")
    expect(seen[1]?.filter((text) => text.startsWith("steering"))).toEqual([
      "steering-0",
      "steering-1",
    ])
    expect(maximum).toBe(1)
    const originalResolutions = resolutions,
      originalPrivilegeChecks = privilegeChecks
    freshResolutionAllowed = false
    privileged = false
    f.defaultAgent("/changed#agent")
    expect((await inject(0)).b4.receipt).toMatchObject({ disposition: "applied", replayed: true })
    expect(resolutions).toBe(originalResolutions)
    expect(privilegeChecks).toBe(originalPrivilegeChecks)
    expect(seen).toHaveLength(2)
  },
  30_000,
)
