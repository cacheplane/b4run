"use client"
import { type KeyboardEvent, useEffect, useRef } from "react"
import { type AirportWeather, worstCategory } from "../lib/weather-selectors"
import { Icon } from "./icons"
import { categoryText } from "./WeatherTab"

export interface MarkerPanelProps {
  /** The marker's id, as the map labels it. */
  readonly id: string
  /** The weather brief's entry for it, or null when the brief has none. */
  readonly airport: AirportWeather | null
  /** Set when the marker is a reporting station near the course. */
  readonly station?: { readonly name: string } | undefined
  readonly onClose: () => void
}

function Report({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <div className="mt-2.5">
      <p className="text-[11px] font-semibold text-wb-muted">{label}</p>
      {text.trim() === "" ? (
        <p className="text-[12.5px] text-wb-muted">No {label} in the brief</p>
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-snug">
          {text}
        </pre>
      )}
    </div>
  )
}

/**
 * The weather for one map marker (an airport on the route or a reporting
 * station near it), from the brief: the category now and at ETA, the raw
 * METAR and the raw TAF. It sits in the map panel's lower-left corner; the
 * map's controls own the lower-right.
 *
 * Focus moves to its close button whenever it opens on a marker (clicking a
 * second marker re-targets it), and goes back to the element focused before
 * (the marker, for a keyboard user) when it closes. Escape inside it closes it.
 */
export function MarkerPanel({ id, airport, station, onClose }: MarkerPanelProps) {
  const closeButton = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new marker is the trigger, not an input
  useEffect(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement && !dialog.current?.contains(active)) {
      returnTo.current = active
    }
    closeButton.current?.focus()
  }, [id])

  useEffect(
    () => () => {
      const target = returnTo.current
      if (target?.isConnected) target.focus()
    },
    [],
  )

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return
    event.stopPropagation()
    onClose()
  }

  const name = station?.name
  return (
    <div
      ref={dialog}
      role="dialog"
      aria-label={`${id} weather`}
      className="wb-marker-panel"
      onKeyDown={onKeyDown}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="font-mono text-[13px] font-bold">{id}</span>
        {name !== undefined && name !== "" && name !== id ? (
          <span className="min-w-0 truncate text-[12.5px] text-wb-muted">{name}</span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          {airport !== null ? (
            <span className="wb-cat" data-cat={worstCategory(airport)}>
              <span className="wb-cat-dot" aria-hidden="true" />
              {categoryText(airport)}
            </span>
          ) : null}
          <button
            ref={closeButton}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="wb-focus grid size-7 place-items-center rounded-full text-wb-muted hover:bg-wb-rail hover:text-wb-text"
          >
            <Icon name="close" className="size-4" />
          </button>
        </span>
      </div>
      {airport === null ? (
        <p className="mt-2 text-[12.5px] text-wb-muted">No report in the brief</p>
      ) : (
        <>
          <Report label="METAR" text={airport.metar} />
          <Report label="TAF" text={airport.taf} />
        </>
      )}
    </div>
  )
}
