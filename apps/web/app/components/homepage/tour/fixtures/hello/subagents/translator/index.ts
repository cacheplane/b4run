import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  description: "Translate a short greeting into the language the user asks for.",
  systemPrompt: "You translate greetings. Reply with the translation only.",
})
