"use client"
import type { ReactNode } from "react"
import { getLesson } from "../../../lib/turn-inspector/lessons"
import { useInspectorActions } from "./inspector-context"
export function InspectMoment({
  lesson,
  moment,
  children,
}: {
  lesson: string
  moment: string
  children: ReactNode
}) {
  const actions = useInspectorActions()
  const entry = getLesson(lesson)
  if (!entry || !entry.moments.includes(moment))
    throw new Error("Unknown authored inspector moment")
  const hash = `#inspect/${encodeURIComponent(lesson)}/${encodeURIComponent(moment)}`
  return (
    <a
      href={`/docs/app/inspect/${encodeURIComponent(lesson)}${hash}`}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return
        if (actions?.inspect(lesson, moment)) {
          event.preventDefault()
          window.history.pushState(null, "", hash)
        }
      }}
    >
      {children}
    </a>
  )
}
