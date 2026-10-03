import { z } from "zod"
import type { B4PlanActivityContent } from "../activities.js"

const todoSchema = z.strictObject({
  content: z.string().trim().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
})

export const planActivityContentSchema = z.strictObject({
  todos: z.array(todoSchema),
})

function assignPlanOutputToPublicType(
  content: z.output<typeof planActivityContentSchema>,
): B4PlanActivityContent {
  return content
}
void assignPlanOutputToPublicType
