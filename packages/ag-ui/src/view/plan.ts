import type { B4PlanActivityContent } from "../activities.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A `b4.plan` snapshot's todos, or undefined unless every entry is well-formed. */
export function readPlan(content: unknown): B4PlanActivityContent["todos"] | undefined {
  if (!isRecord(content) || !Array.isArray(content.todos)) return undefined
  const todos: Array<B4PlanActivityContent["todos"][number]> = []
  for (const todo of content.todos) {
    if (!isRecord(todo) || typeof todo.content !== "string") return undefined
    if (todo.status !== "pending" && todo.status !== "in_progress" && todo.status !== "completed") {
      return undefined
    }
    todos.push({ content: todo.content, status: todo.status })
  }
  return todos
}
