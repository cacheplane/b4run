import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: "You are a friendly assistant. Use greet to greet people by name.",
})
