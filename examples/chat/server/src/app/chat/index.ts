import { agent } from "@b4run/sdk"
import { HARNESS_SYSTEM_PROMPT } from "./system-prompt.js"

export default agent({
  model: "gpt-5",
  reasoning: { effort: "high" },
  systemPrompt: HARNESS_SYSTEM_PROMPT,
})
