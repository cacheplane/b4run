import { agent } from "@b4run/sdk"
export default agent({
  model: "gpt-5-mini",
  systemPrompt: "You are a test agent. Use fileReport when asked to file.",
  tools: { approve: [{ tool: "fileReport", allowAlways: false }] },
})
