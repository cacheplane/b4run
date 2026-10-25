import { toolStepMiddleware } from "@b4run/langgraph/ui"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { tool } from "@langchain/core/tools"
import { type AgentMiddleware, createAgent } from "langchain"

/** Build a plain agent with an application-supplied model (for example gpt-5-mini). */
export function createLookupAgent(model: BaseChatModel, approvalGate: AgentMiddleware) {
  const lookup = tool(async () => "Found record", {
    name: "lookup",
    description: "Look up a record",
    schema: { type: "object", properties: {}, additionalProperties: false } as const,
  })
  return createAgent({
    model,
    tools: [lookup],
    middleware: [
      approvalGate,
      toolStepMiddleware({
        display: {
          lookup: {
            icon: "search",
            running: () => "Looking up record",
            done: (_args, message) =>
              typeof message.content === "string" ? message.content : "Found record",
            sources: (message) => [
              { id: message.tool_call_id, kind: "record", title: "Lookup result" },
            ],
          },
        },
      }),
    ],
  })
}
