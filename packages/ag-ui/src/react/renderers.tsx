import type { ReactActivityMessageRenderer } from "@copilotkit/react-core/v2"
import { B4_PLAN_ACTIVITY_TYPE, type B4PlanActivityContent } from "../activities.js"
import { PlanActivityCard } from "./PlanActivityCard.js"
import { planActivityContentSchema } from "./schemas.js"

export const b4PlanActivityRenderer = {
  activityType: B4_PLAN_ACTIVITY_TYPE,
  content: planActivityContentSchema,
  render: ({ content }) => <PlanActivityCard content={content} />,
} satisfies ReactActivityMessageRenderer<B4PlanActivityContent>

/**
 * B4.run's built-in activity renderer set, ready to hand to CopilotKit:
 *
 * ```tsx
 * import { CopilotKit } from "@copilotkit/react-core/v2"
 *
 * <CopilotKit
 *   runtimeUrl="/api/copilotkit"
 *   useSingleEndpoint={false}
 *   renderActivityMessages={b4ActivityRenderers}
 * >
 * ```
 *
 * B4.run presents `writeTodos` ONLY as the `b4.plan` activity — a client that
 * registers no renderer for it shows nothing for that work. Subagents are not
 * activities: they arrive as AG-UI 1.0 `SUBAGENT_*` events plus events tagged
 * `subagentRunId`, which `useSubagentRuns` reduces and `SubagentPanel` renders.
 */
export const b4ActivityRenderers = [b4PlanActivityRenderer]
