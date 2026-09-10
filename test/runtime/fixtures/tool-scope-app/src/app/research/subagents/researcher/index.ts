import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "RESEARCHER_SUBAGENT_MARKER read-only researcher.",
  tools: { allow: ["readFile"] },
})
