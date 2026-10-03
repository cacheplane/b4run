import { agent } from "@b4run/sdk"
export default agent({
  model: "gpt-4o-mini",
  systemPrompt: "You are a test agent. Use the provided tools when asked.",
})
