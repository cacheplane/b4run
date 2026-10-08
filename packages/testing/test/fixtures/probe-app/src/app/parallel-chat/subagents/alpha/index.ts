import { agent } from "@b4run/sdk"
export default agent({
  model: "gpt-5-mini",
  description: "Looks up the alpha half of a job.",
  systemPrompt: "You are the alpha worker. Use lookupAlpha, then report what it returned.",
})
