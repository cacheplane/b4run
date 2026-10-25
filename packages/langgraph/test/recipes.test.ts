import { spawnSync } from "node:child_process"
import { B4_TOOL_STEP_JSON_SCHEMA, readToolStep } from "@b4run/sdk"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage, isToolMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { RunnableLambda } from "@langchain/core/runnables"
import { Validator } from "@langchain/core/utils/json_schema"
import { createMiddleware } from "langchain"
import { expect, test } from "vitest"
import { lookupWithSteps } from "../examples/manual-tool.ts"
import { createLookupAgent } from "../examples/plain-agent.ts"

/** Deterministic recipe model; no provider or network calls. */
class RecipeModel extends BaseChatModel {
  _llmType() {
    return "recipe-test"
  }
  bindTools() {
    return this
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    return {
      generations: [
        {
          text: "",
          message: messages.some(isToolMessage)
            ? new AIMessage("done")
            : new AIMessage({
                content: "",
                tool_calls: [{ id: "lookup", name: "lookup", args: {} }],
              }),
        },
      ],
    }
  }
}

test("plain agent recipe uses actual ToolMessage display output", async () => {
  const gate = createMiddleware({
    name: "approved",
    wrapToolCall: (request, handler) => handler(request),
  })
  const agent = createLookupAgent(new RecipeModel({}), gate)

  const result = await agent.invoke({ messages: [{ role: "user", content: "lookup" }] })

  expect(result.messages.filter(isToolMessage)).toMatchObject([
    {
      additional_kwargs: {
        b4_step: {
          status: "completed",
          label: "Found record",
          sources: [{ id: "lookup", kind: "record", title: "Lookup result" }],
        },
      },
    },
  ])
})

test("manual node recipe emits schema-valid live steps and returns checkpoint data without identity", async () => {
  const runnable = RunnableLambda.from(async (_input, config) => lookupWithSteps(config, "manual"))
  const validator = new Validator(JSON.parse(JSON.stringify(B4_TOOL_STEP_JSON_SCHEMA)))
  const events = []

  for await (const event of runnable.streamEvents({}, { version: "v2" })) events.push(event)
  const result = await runnable.invoke({})

  const steps = events
    .filter((event) => event.event === "on_custom_event" && event.name === "b4.step")
    .map((event) => event.data)
  expect(steps.map((step) => readToolStep(step)?.status)).toEqual(["running", "completed"])
  for (const step of steps) expect(validator.validate(step)).toMatchObject({ valid: true })
  expect(result.additional_kwargs.b4_step).toMatchObject({ v: 1, status: "completed" })
  expect(result.additional_kwargs.b4_step).not.toHaveProperty("toolCallId")
})

test.skipIf(!process.env.B4_LANGGRAPH_PYTHON)(
  "Python recipe against the installed real bridge",
  () => {
    const executable = process.env.B4_LANGGRAPH_PYTHON ?? "python3"

    const result = spawnSync(
      executable,
      ["packages/langgraph/examples/python_tool_steps_test.py"],
      {
        cwd: new URL("../../../", import.meta.url),
        encoding: "utf8",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
        // External interpreter startup and cold bridge imports can exceed unit-test budgets.
        timeout: 120_000,
      },
    )

    expect(result.stdout + result.stderr).toContain("recipe checks passed")
    expect(result.status).toBe(0)
  },
  150_000,
)
