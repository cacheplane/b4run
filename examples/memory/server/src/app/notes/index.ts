import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt:
    "You are a note-taking assistant with long-term memory. Use the remember and recall tools.",
})
