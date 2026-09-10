import type { ReactActivityMessageRenderer } from "@copilotkit/react-core/v2"
import {
  B4_PLAN_ACTIVITY_TYPE,
  B4_SUBAGENT_ACTIVITY_TYPE,
  type B4PlanActivityContent,
} from "../activities.js"
import { PlanActivityCard } from "./PlanActivityCard.js"
import { SubagentActivityCard } from "./SubagentActivityCard.js"
import {
  planActivityContentSchema,
  type SubagentActivityContentOutput,
  subagentActivityContentSchema,
} from "./schemas.js"

export const b4PlanActivityRenderer = {
  activityType: B4_PLAN_ACTIVITY_TYPE,
  content: planActivityContentSchema,
  render: ({ content }) => <PlanActivityCard content={content} />,
} satisfies ReactActivityMessageRenderer<B4PlanActivityContent>

/**
 * Typed against `SubagentActivityContentOutput`, not the published
 * `B4SubagentActivityContent`: zod passes an input's own `todos: undefined`
 * key straight through, so the parsed value is genuinely wider than the
 * exact-optional public type this package compiles against. `SubagentActivityCard`
 * branches on `content.todos !== undefined` and renders both shapes identically.
 */
export const b4SubagentActivityRenderer = {
  activityType: B4_SUBAGENT_ACTIVITY_TYPE,
  content: subagentActivityContentSchema,
  render: ({ content }) => <SubagentActivityCard content={content} />,
} satisfies ReactActivityMessageRenderer<SubagentActivityContentOutput>

/**
 * Both built-in B4.run activity renderers, ready to hand to CopilotKit:
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
 * B4.run presents `writeTodos` and a started `task` ONLY as these activities —
 * a client that registers no renderer for them shows nothing for that work.
 */
export const b4ActivityRenderers = [b4PlanActivityRenderer, b4SubagentActivityRenderer]
