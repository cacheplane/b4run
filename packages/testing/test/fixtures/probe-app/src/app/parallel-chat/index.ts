import { agent } from "@b4run/sdk"
export default agent({
  model: "gpt-5-mini",
  systemPrompt: "You are a dispatcher. Hand each part of the job to its subagent with task.",
})
