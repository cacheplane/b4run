"use client"
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
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
  type RouteDraft,
  replanMessage,
} from "../lib/route-draft"
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

  // Reset to the plan whenever a new plan arrives. The mount's plan is the
  // initial state already; a null plan never wipes the draft.
  const appliedNavlog = useRef(navlog)
  useEffect(() => {
    if (navlog === appliedNavlog.current) return
    appliedNavlog.current = navlog
    if (navlog !== null) dispatch({ type: "reset", draft: draftFromNavlog(navlog) })
  }, [navlog])

  const onDraftChangeRef = useRef(onDraftChange)
  onDraftChangeRef.current = onDraftChange
  useEffect(() => {
    onDraftChangeRef.current(draft)
  }, [draft])

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
          <ol className="wb-routebar-pills" aria-label="Waypoints">
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
              >
                <span className="wb-routebar-id">{waypoint.id}</span>
                <button
                  type="button"
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
      <label className="wb-routebar-field">
        <input
          type="text"
          className="wb-routebar-small wb-focus"
          aria-label="Cruise altitude, feet"
          inputMode="numeric"
          placeholder="Altitude"
          value={draft.altitudeFt}
          onChange={(event) => dispatch({ type: "altitude", value: event.target.value })}
        />
        <span aria-hidden="true">ft</span>
      </label>
      <input
        type="text"
        className="wb-routebar-small wb-routebar-departure wb-focus"
        aria-label="Departure time"
        placeholder="Dep 1400Z"
        value={draft.departure}
        onChange={(event) => dispatch({ type: "departure", value: event.target.value })}
      />
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
