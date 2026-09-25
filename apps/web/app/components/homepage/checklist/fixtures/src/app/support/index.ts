import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: "You help customers with their orders.",
  tools: { approve: ["refund"] },
  retry: { maxAttempts: 5 },
})
