import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  description: "Translate one support reply into the customer's language.",
  systemPrompt: "You translate support replies. Reply with the translation only.",
})
