import { agent } from "@b4run/sdk"
export default agent({
  model: "gpt-4o-mini",
  systemPrompt:
    "You are a note-taking agent with long-term memory in candidate (review) mode. Use remember/recall when asked.",
})
