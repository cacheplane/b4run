"use client"
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react"
import type { Navlog } from "../lib/navlog-types"
import {
  type DraftWaypoint,
  draftDistanceNm,
  draftFromNavlog,
  draftReducer,
  EMPTY_DRAFT,
  moveWaypoint,
  type RouteDraft,
  replanMessage,
} from "../lib/route-draft"
import { type PillDrag, usePillReorder } from "../lib/use-pill-reorder"
import type { Waypoint } from "../lib/waypoint-search"

export interface WaypointSearchResult {
  readonly results: readonly Waypoint[]
  readonly snapshot: string
}

export type WaypointSearch = (q: string, signal: AbortSignal) => Promise<WaypointSearchResult>

export interface RouteBarProps {
  /** The current plan; a new plan object resets the bar to its route. */
  readonly navlog: Navlog | null
  /** A run is in flight: Replan waits for it. */
  readonly running: boolean
  /** Called with the Replan message (`replanMessage(draft)`). */
  readonly onReplan: (text: string) => void
  /** Called with every draft, the map draws it. */
  readonly onDraftChange: (draft: RouteDraft) => void
  /** The waypoint search. Defaults to `GET /api/waypoints?q=`. */
  readonly search?: WaypointSearch
}

const DEBOUNCE_MS = 120

const fetchWaypoints: WaypointSearch = async (q, signal) => {
  const response = await fetch(`/api/waypoints?q=${encodeURIComponent(q)}`, { signal })
  if (!response.ok) throw new Error(`waypoint search failed: ${response.status}`)
  return (await response.json()) as WaypointSearchResult
}

/** "Airport", "VORTAC 117.30" (MHz from kHz), "NDB 338 kHz". */
export function waypointKindLabel(waypoint: Waypoint): string {
  if (waypoint.kind === "airport") return "Airport"
  if (waypoint.freqKhz === undefined) return waypoint.type
  if (waypoint.type.startsWith("NDB")) return `${waypoint.type} ${waypoint.freqKhz} kHz`
  return `${waypoint.type} ${(waypoint.freqKhz / 1000).toFixed(2)}`
}

const waypointKey = (waypoint: Waypoint): string =>
  `${waypoint.kind}:${waypoint.id}:${waypoint.lat},${waypoint.lon}`

const toDraftWaypoint = (waypoint: Waypoint): DraftWaypoint => ({
  id: waypoint.id,
  kind: waypoint.kind,
  type: waypoint.type,
  lat: waypoint.lat,
  lon: waypoint.lon,
})

/**
 * The route bar: the plan's waypoints as pills, a combobox that adds more
 * from the bundled snapshot, altitude, departure, the draft's total distance
 * and one Replan button. The draft lives here; the bar reports it on every
 * change and sends Replan as an ordinary chat message.
 *
 * Keys in the combobox: ArrowUp/ArrowDown move through the options, Enter or
 * Tab adds the active one, Escape closes the list, Backspace on an empty
 * input removes the last pill. Space adds a waypoint only when the typed text
 * is exactly a result's id (ids never hold spaces; names do, so otherwise the
 * space is typed). Enter on an empty input submits the form.
 *
 * The pills reorder the route: drag one along the row (`usePillReorder`; on
 * a touch screen, hold it first), or focus its id and press ArrowLeft,
 * ArrowRight, Home or End. The map draws the order a drag would make while it
 * is under way, the draft changes on drop, and a live region says where the
 * waypoint went.
 */
export function RouteBar({
  navlog,
  running,
  onReplan,
  onDraftChange,
  search = fetchWaypoints,
}: RouteBarProps) {
  const [draft, dispatch] = useReducer(draftReducer, navlog, (initial) =>
    initial === null ? EMPTY_DRAFT : draftFromNavlog(initial),
  )
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<readonly Waypoint[]>([])
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [closed, setClosed] = useState(false)
  const listId = useId()
  const reorderHintId = useId()
  // What the live region last said about a move.
  const [announcement, setAnnouncement] = useState("")
  // The grip to focus once a keyboard move has re-rendered the pills.
  const gripRefs = useRef<(HTMLButtonElement | null)[]>([])
  const focusAfterMove = useRef<number | null>(null)

  // Reset to the plan whenever a new plan arrives. The mount's plan is the
  // initial state already; a null plan never wipes the draft.
  const appliedNavlog = useRef(navlog)
  useEffect(() => {
    if (navlog === appliedNavlog.current) return
    appliedNavlog.current = navlog
    if (navlog !== null) dispatch({ type: "reset", draft: draftFromNavlog(navlog) })
  }, [navlog])

  const move = (from: number, to: number): void => {
    const moved = draft.waypoints[from]
    if (moved === undefined || moveWaypoint(draft.waypoints, from, to) === null) return
    dispatch({ type: "move", from, to })
    setAnnouncement(`Moved ${moved.id} to position ${to + 1} of ${draft.waypoints.length}`)
  }
  const { listRef, drag, pillHandlers } = usePillReorder({ onMove: move })

  // While a drag is under way the map draws the order it would make; an order
  // the draft would refuse previews as no change.
  const dragFrom = drag?.from
  const dragTo = drag?.to
  const previewWaypoints = useMemo(
    () =>
      dragFrom === undefined || dragTo === undefined
        ? null
        : moveWaypoint(draft.waypoints, dragFrom, dragTo),
    [draft.waypoints, dragFrom, dragTo],
  )
  const shownDraft = useMemo(
    () => (previewWaypoints === null ? draft : { ...draft, waypoints: previewWaypoints }),
    [draft, previewWaypoints],
  )

  const onDraftChangeRef = useRef(onDraftChange)
  onDraftChangeRef.current = onDraftChange
  useEffect(() => {
    onDraftChangeRef.current(shownDraft)
  }, [shownDraft])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the new order is the trigger, not an input
  useEffect(() => {
    const index = focusAfterMove.current
    if (index === null) return
    focusAfterMove.current = null
    gripRefs.current[index]?.focus()
  }, [draft.waypoints])

  const onGripKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const last = draft.waypoints.length - 1
    const to =
      event.key === "ArrowLeft"
        ? index - 1
        : event.key === "ArrowRight"
          ? index + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null
    if (to === null) return
    event.preventDefault()
    if (to < 0 || to > last || moveWaypoint(draft.waypoints, index, to) === null) return
    focusAfterMove.current = to
    move(index, to)
  }

  // Debounced search; the previous request is aborted and a stale answer is
  // dropped, so the list always belongs to the text in the input.
  const searchRef = useRef(search)
  searchRef.current = search
  const latestQuery = useRef("")
  useEffect(() => {
    const q = query.trim()
    latestQuery.current = q
    if (q === "") {
      setResults([])
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      searchRef.current(q, controller.signal).then(
        (response) => {
          if (controller.signal.aborted || latestQuery.current !== q) return
          setResults(response.results)
          setSnapshot(response.snapshot)
          setActive(0)
        },
        () => {
          if (controller.signal.aborted || latestQuery.current !== q) return
          setResults([])
        },
      )
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  const open = !closed && query.trim() !== "" && results.length > 0
  const activeIndex = Math.min(active, results.length - 1)
  const optionId = (index: number): string => `${listId}-option-${index}`

  const commit = (waypoint: Waypoint): void => {
    dispatch({ type: "add", waypoint: toDraftWaypoint(waypoint) })
    setQuery("")
    setResults([])
    setActive(0)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const option = results[activeIndex]
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (results.length === 0) return
        event.preventDefault()
        if (closed) {
          setClosed(false)
          return
        }
        const step = event.key === "ArrowDown" ? 1 : -1
        setActive((activeIndex + step + results.length) % results.length)
        return
      }
      case "Enter":
      case "Tab":
        if (open && option !== undefined) {
          event.preventDefault()
          commit(option)
        } else if (event.key === "Enter" && query.trim() !== "") {
          // Unmatched text is not a route: keep it out of the Replan submit.
          event.preventDefault()
        }
        return
      case " ": {
        if (query === "" || query.includes(" ")) return
        const typed = query.toLowerCase()
        const exact = results.find((result) => result.id.toLowerCase() === typed)
        if (exact === undefined) return
        event.preventDefault()
        commit(exact)
        return
      }
      case "Escape":
        if (open) {
          event.preventDefault()
          setClosed(true)
        }
        return
      case "Backspace":
        if (query === "" && draft.waypoints.length > 0) dispatch({ type: "removeLast" })
        return
    }
  }

  const message = replanMessage(draft)
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (message === null || running) return
    onReplan(message)
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a form, so Enter and the submit button replan
    <form className="wb-routebar" role="search" aria-label="Route" onSubmit={onSubmit}>
      <div className="wb-routebar-route">
        {draft.waypoints.length > 0 ? (
          <ol ref={listRef} className="wb-routebar-pills" aria-label="Waypoints">
            {draft.waypoints.map((waypoint, index) => (
              <li
                // Ids repeat in a route (out and back), so the position is part of the key.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                key={`${index}:${waypoint.kind}:${waypoint.id}`}
                className={
                  waypoint.kind === "navaid"
                    ? "wb-routebar-pill wb-routebar-pill-navaid"
                    : "wb-routebar-pill"
                }
                title={waypoint.kind === "navaid" ? waypoint.type : undefined}
                {...dragAttributes(drag, previewWaypoints !== null, index)}
                {...pillHandlers(index)}
              >
                {/*
                  The id is the pill's grip: the keyboard's way to reorder, and
                  what a screen reader announces with the waypoint's position.
                */}
                <button
                  ref={(element) => {
                    gripRefs.current[index] = element
                  }}
                  type="button"
                  className="wb-routebar-grip wb-focus"
                  aria-label={`${waypoint.id}, waypoint ${index + 1} of ${draft.waypoints.length}`}
                  aria-describedby={reorderHintId}
                  onKeyDown={(event) => onGripKeyDown(event, index)}
                >
                  <span className="wb-routebar-id">{waypoint.id}</span>
                </button>
                <button
                  type="button"
                  data-no-drag=""
                  className="wb-routebar-remove wb-focus"
                  aria-label={`Remove ${waypoint.id}`}
                  onClick={() => dispatch({ type: "remove", index })}
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
        ) : null}
        <span id={reorderHintId} className="sr-only">
          Drag to reorder, or press the left and right arrow keys
        </span>
        <span role="status" className="sr-only">
          {announcement}
        </span>
        <input
          type="text"
          className="wb-routebar-input"
          role="combobox"
          aria-label="Add waypoint"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          {...(open ? { "aria-activedescendant": optionId(activeIndex) } : {})}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            draft.waypoints.length === 0 ? "Type a route: KPAO SNS KSBA" : "add waypoint…"
          }
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setClosed(false)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setClosed(true)}
          onFocus={() => setClosed(false)}
        />
        <div className="wb-routebar-popup" hidden={!open}>
          <div id={listId} className="wb-routebar-list" role="listbox" aria-label="Waypoints found">
            {open
              ? results.map((result, index) => (
                  // Options take no focus: the combobox keeps it and points at the
                  // active one with aria-activedescendant, and owns the keys.
                  // biome-ignore lint/a11y/useFocusableInteractive: see above
                  // biome-ignore lint/a11y/useKeyWithClickEvents: see above
                  <div
                    key={waypointKey(result)}
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === activeIndex}
                    className="wb-routebar-option"
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => commit(result)}
                  >
                    <span className="wb-routebar-id">{result.id}</span>
                    <span className="wb-routebar-name">{result.name}</span>
                    <span className="wb-routebar-kind">{waypointKindLabel(result)}</span>
                  </div>
                ))
              : null}
          </div>
          {snapshot !== null ? (
            <p className="wb-routebar-note">
              Waypoints: OurAirports {snapshot}, not for navigation
            </p>
          ) : null}
        </div>
      </div>
      {/*
        Altitude and departure as one joined control with visible labels, not
        two loose placeholder-only boxes: the label says what each field is
        once a value replaces the placeholder.
      */}
      <fieldset className="wb-routebar-fields">
        <legend className="sr-only">Flight</legend>
        <label className="wb-routebar-field">
          <span className="wb-routebar-field-label" aria-hidden="true">
            Alt
          </span>
          <input
            type="text"
            className="wb-routebar-field-input wb-routebar-altitude"
            aria-label="Cruise altitude, feet"
            inputMode="numeric"
            value={draft.altitudeFt}
            onChange={(event) => dispatch({ type: "altitude", value: event.target.value })}
          />
          <span className="wb-routebar-field-unit" aria-hidden="true">
            ft
          </span>
        </label>
        <label className="wb-routebar-field">
          <span className="wb-routebar-field-label" aria-hidden="true">
            Dep
          </span>
          <input
            type="text"
            className="wb-routebar-field-input wb-routebar-departure"
            aria-label="Departure time"
            title="1400Z, tomorrow 1400Z, or an ISO time"
            placeholder="1400Z"
            value={draft.departure}
            onChange={(event) => dispatch({ type: "departure", value: event.target.value })}
          />
        </label>
      </fieldset>
      {draft.waypoints.length >= 2 ? (
        <span className="wb-routebar-total">{draftDistanceNm(draft)} nm</span>
      ) : null}
      <button
        type="submit"
        className="wb-routebar-submit wb-focus"
        disabled={message === null || running}
        title={replanHint(draft, running)}
      >
        {navlog !== null ? "Replan" : "Plan"}
      </button>
    </form>
  )
}

/**
 * A pill's drag attributes: `data-dragging` (and its travel, which the pill
 * follows) on the one being dragged, and `data-drop` on the pill the insertion
 * line sits beside, when the drop would change the order.
 */
function dragAttributes(drag: PillDrag | null, changes: boolean, index: number) {
  if (drag === null) return {}
  if (index === drag.from) {
    return {
      "data-dragging": "",
      style: { "--wb-drag-dx": `${drag.dx}px` } as CSSProperties,
    }
  }
  if (!changes || index !== drag.to) return {}
  return { "data-drop": drag.to < drag.from ? "before" : "after" }
}

/** Why Plan/Replan is disabled, as its tooltip; empty when it is enabled. */
function replanHint(draft: RouteDraft, running: boolean): string {
  if (running) return "Wait for the current run to finish"
  if (draft.waypoints.length < 2) return "Add at least two waypoints"
  if (replanMessage(draft) !== null) return ""
  if (draft.departure.trim() === "" && draft.departureFromPlan === null) {
    return "Add a cruise altitude (1000–17500 ft) and a departure time"
  }
  return "Add a cruise altitude from 1000 to 17500 ft"
}
