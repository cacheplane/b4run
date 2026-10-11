"use client"
import type { useAgent } from "@copilotkit/react-core/v2"
import { useCallback, useEffect, useState } from "react"
import type { DropNotice } from "../components/DropNotices"

/** The `CUSTOM` event name `packages/langchain` emits when parts never reached the model. */
const CONTENT_PARTS_DROPPED_EVENT = "b4.content_parts_dropped"

/**
 * A `b4.content_parts_dropped` value as far as the notices need it: a `parts`
 * list of `{ type, reason }` entries. The event crosses the network, so it is
 * checked rather than cast; a payload that fails is dropped quietly (the
 * notice is a courtesy, not the run's outcome).
 */
export function asDropNotice(value: unknown): DropNotice | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { parts, toolCallId } = value as { parts?: unknown; toolCallId?: unknown }
  if (!Array.isArray(parts) || parts.length === 0) return undefined
  const valid = parts.every(
    (part) =>
      typeof part === "object" &&
      part !== null &&
      typeof (part as { type?: unknown }).type === "string" &&
      typeof (part as { reason?: unknown }).reason === "string",
  )
  if (!valid) return undefined
  if (toolCallId !== undefined && typeof toolCallId !== "string") return undefined
  return value as DropNotice
}

type Agent = Pick<ReturnType<typeof useAgent>["agent"], "subscribe">

/**
 * Parts the model never saw (`b4.content_parts_dropped`, emitted by the
 * langchain adapter when the provider or model cannot take a part), as
 * notices for the dock, in arrival order.
 *
 * Not on the agent: CopilotKit keeps no record of CUSTOM events, so this list
 * is the only place they live. `clear` is for a thread switch — the notices
 * belong to the thread they arrived on.
 *
 * Same subscription lifecycle as the memory queue's `onRunFinishedEvent`:
 * keyed on the agent instance, so a swap re-subscribes the new one and
 * unsubscribes the old.
 */
export function useDropNotices(agent: Agent): {
  readonly notices: readonly DropNotice[]
  readonly clear: () => void
} {
  const [notices, setNotices] = useState<readonly DropNotice[]>([])

  useEffect(() => {
    const subscription = agent.subscribe({
      onCustomEvent: ({ event }) => {
        if (event.name !== CONTENT_PARTS_DROPPED_EVENT) return
        const notice = asDropNotice(event.value)
        if (notice === undefined) return
        setNotices((current) => [...current, notice])
      },
    })
    return () => {
      subscription.unsubscribe()
    }
  }, [agent])

  const clear = useCallback(() => setNotices([]), [])
  return { notices, clear }
}
