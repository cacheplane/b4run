"use client"
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Capture } from "../../../lib/turn-inspector/capture-types"
import { getLesson } from "../../../lib/turn-inspector/lessons"
import { readCaptureAsset } from "../../../lib/turn-inspector/load-capture"
import { InspectorFallback } from "./InspectorFallback"
import { useInspectorActions } from "./inspector-context"

const Replay = lazy(() =>
  import("./TurnInspector").then((module) => ({ default: module.TurnInspector })),
)
export function InspectorLoader({ lesson }: { lesson: string }) {
  const entry = useMemo(() => getLesson(lesson), [lesson])
  if (!entry) throw new Error("Unknown authored inspector lesson")
  // A keyed child resets pending requests and state when a lesson changes.
  return <Loader key={lesson} lesson={lesson} />
}
function Loader({ lesson }: { lesson: string }) {
  const entry = useMemo(() => getLesson(lesson), [lesson])
  if (!entry) throw new Error("Unknown inspector lesson")
  const [capture, setCapture] = useState<Capture | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [moment, setMoment] = useState<{ id: string; request: number } | undefined>()
  const root = useRef<HTMLDivElement>(null)
  const controller = useRef<AbortController | null>(null)
  const loaded = useRef(false)
  const actions = useInspectorActions()
  const load = useCallback(() => {
    if (controller.current || loaded.current) return
    const abort = new AbortController()
    controller.current = abort
    setLoading(true)
    setError("")
    void readCaptureAsset(entry.digest, abort.signal)
      .then((value) => {
        if (abort.signal.aborted) return
        if (
          value.id !== entry.id ||
          Object.keys(entry.revisions).some(
            (key) =>
              value.revisions[key as keyof Capture["revisions"]] !==
              entry.revisions[key as keyof Capture["revisions"]],
          ) ||
          entry.moments.some((id) => !value.moments.some((m) => m.id === id))
        )
          throw new Error("Lesson metadata mismatch")
        loaded.current = true
        setCapture(value)
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError("This recording could not be loaded. Read the transcript or try again.")
      })
      .finally(() => {
        if (!abort.signal.aborted) {
          controller.current = null
          setLoading(false)
        }
      })
  }, [entry])
  const inspect = useCallback(
    (id: string) => {
      if (!entry.moments.includes(id)) {
        load()
        setError("That moment is not part of this recording.")
        return
      }
      setMoment((current) => ({ id, request: (current?.request ?? 0) + 1 }))
      load()
    },
    [entry, load],
  )
  useEffect(() => actions?.register(lesson, inspect), [actions, lesson, inspect])
  useEffect(() => {
    const restore = () => {
      const parts = window.location.hash.split("/")
      if (parts[0] === "#inspect" && parts[1] === lesson && parts[2]) inspect(parts[2])
    }
    restore()
    window.addEventListener("popstate", restore)
    window.addEventListener("hashchange", restore)
    return () => {
      window.removeEventListener("popstate", restore)
      window.removeEventListener("hashchange", restore)
    }
  }, [lesson, inspect])
  useEffect(() => {
    const node = root.current
    if (!node || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          load()
          observer.disconnect()
        }
      },
      { rootMargin: "200px" },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [load])
  useEffect(
    () => () => {
      controller.current?.abort()
      controller.current = null
    },
    [],
  )
  return (
    <div ref={root} data-inspector-lesson={lesson}>
      <InspectorFallback lesson={entry} />
      {error && <p role="status">{error}</p>}
      {!capture && (
        <button type="button" disabled={loading} onClick={load}>
          {loading ? "Loading recording…" : error ? "Try again" : "Explore the recorded turn"}
        </button>
      )}
      {capture && (
        <Suspense fallback={<p role="status">Opening inspector…</p>}>
          <Replay sources={entry.sources} capture={capture} {...(moment ? { moment } : {})} />
        </Suspense>
      )}
    </div>
  )
}
