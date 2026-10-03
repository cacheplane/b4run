import { Annotation, MessagesAnnotation, ReducedValue, StateSchema } from "@langchain/langgraph"
import { z } from "zod"

export interface ResolvedStateField {
  readonly name: string
  readonly reducer: "append" | "replace" | ((current: unknown, incoming: unknown) => unknown)
  readonly default: unknown
}

export function materializeStateSchema(fields: readonly ResolvedStateField[]) {
  const spec: Record<string, unknown> = {
    ...MessagesAnnotation.spec,
  }

  for (const field of fields) {
    if (typeof field.reducer === "function") {
      spec[field.name] = Annotation({
        reducer: field.reducer as (left: unknown, right: unknown) => unknown,
        default: () => field.default,
      })
    } else if (field.reducer === "append") {
      spec[field.name] = Annotation({
        reducer: (prev: unknown[], next: unknown) => [
          ...(prev ?? []),
          ...(Array.isArray(next) ? next : [next]),
        ],
        default: () => (field.default ?? []) as unknown[],
      })
    } else {
      spec[field.name] = Annotation({
        reducer: (_: unknown, next: unknown) => next,
        default: () => field.default,
      })
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: dynamically-built spec doesn't satisfy strict StateDefinition type
  return Annotation.Root(spec as any)
}

/**
 * The `createAgent` form of {@link materializeStateSchema}: `createAgent`
 * accepts a `StateSchema` (or a zod object) but not an `Annotation.Root`, and
 * it declares `messages` itself, so only the route's own fields appear here.
 * Each field keeps its reducer through a `ReducedValue`; the value schema is
 * `z.any()` because a route's state is typed by the route, not validated at
 * the graph boundary, and its `.default()` seeds the field's declared default.
 */
export function materializeAgentStateSchema(fields: readonly ResolvedStateField[]) {
  const spec: Record<string, ReducedValue<unknown, unknown>> = {}
  for (const field of fields) {
    const initial = field.reducer === "append" ? (field.default ?? []) : field.default
    spec[field.name] = new ReducedValue(
      z.any().default(() => initial),
      { reducer: reducerFor(field) },
    )
  }
  return new StateSchema(spec)
}

function reducerFor(field: ResolvedStateField): (current: unknown, incoming: unknown) => unknown {
  if (typeof field.reducer === "function") return field.reducer
  if (field.reducer === "append") {
    return (current, incoming) => [
      ...((current as unknown[] | undefined) ?? []),
      ...(Array.isArray(incoming) ? incoming : [incoming]),
    ]
  }
  return (_current, incoming) => incoming
}
