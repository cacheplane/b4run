import { agent, type DelegationConstraintPredicate } from "@b4run/sdk"
import translator from "./subagents/translator/index.js"

// The translator gets one reply at a time, never a whole thread.
const oneReply: DelegationConstraintPredicate = ({ input }) =>
  input.length <= 2_000 || "Send the translator one reply at a time."

export default agent({
  model: "gpt-5-mini",
  systemPrompt: "You answer support questions. Refund an order only when the policy allows it.",
  tools: {
    approve: ["refund"],
    deny: ["deleteUser"],
  },
  subagents: { translator },
  delegation: {
    rules: { translator: { action: "constrain", predicate: oneReply } },
  },
})
