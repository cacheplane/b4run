import { agent } from "@b4run/sdk"
export default agent({
  model: "gpt-5-mini",
  description: "Looks up the beta half of a job.",
  systemPrompt: "You are the beta worker. Use lookupBeta, then report what it returned.",
})
