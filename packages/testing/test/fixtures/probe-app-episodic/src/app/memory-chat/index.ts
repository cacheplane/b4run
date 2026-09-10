import { agent } from "@b4run/sdk"
export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "You are a test agent with long-term memory. Use remember/recall when asked.",
})
