import { describe, expect, test } from "vitest"
import { planActivityContentSchema } from "../../src/react/schemas.js"

const validPlanContent = {
  todos: [
    { content: "Search the corpus", status: "in_progress" },
    { content: "Write the report", status: "pending" },
  ],
}

describe("planActivityContentSchema", () => {
  test("parses a valid plan payload", () => {
    const result = planActivityContentSchema.safeParse(validPlanContent)
    expect(result.success).toBe(true)
  })

  test("rejects an unknown extra field", () => {
    const result = planActivityContentSchema.safeParse({
      ...validPlanContent,
      tool_call_id: "call-1",
    })
    expect(result.success).toBe(false)
  })

  test("rejects a wrong-typed field", () => {
    const result = planActivityContentSchema.safeParse({ todos: "Write the report" })
    expect(result.success).toBe(false)
  })

  test("exposes the Standard Schema validate hook CopilotKit calls", () => {
    expect(typeof planActivityContentSchema["~standard"].validate).toBe("function")
  })
})
