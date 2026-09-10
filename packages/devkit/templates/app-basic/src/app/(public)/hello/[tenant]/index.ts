import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt:
    "You are a helpful assistant for the {tenant} organization. Answer questions about the tenant.",
})
