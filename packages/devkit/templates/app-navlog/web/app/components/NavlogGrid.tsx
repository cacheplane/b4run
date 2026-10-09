"use client"
import { type PretableColumn, PretableSurface } from "@pretable/react"
import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { LEG_COLUMNS, legName } from "../lib/navlog-columns"
import type { Navlog, NavlogLeg } from "../lib/navlog-types"

interface LegRow {
  readonly id: string
  readonly leg: NavlogLeg
}

const rowId = (index: number): string => `leg-${index}`
const indexOf = (id: string): number | null => {
  const match = /^leg-(\d+)$/.exec(id)
  return match ? Number(match[1]) : null
}

/** Leg pinned left, then the paper navlog's figures. Route order is the meaning, so no sort or filter. */
const COLUMNS: PretableColumn<LegRow>[] = [
  {
    id: "leg",
    header: "Leg",
    pinned: "left",
    flex: 1,
    minWidthPx: 150,
    sortable: false,
    filterable: false,
    reorderable: false,
    value: (row) => legName(row.leg),
  },
  ...LEG_COLUMNS.map(
    (column): PretableColumn<LegRow> => ({
      id: column.key,
      header: column.label,
      align: "end",
      sortable: false,
      filterable: false,
      value: (row) => column.value(row.leg),
    }),
  ),
]

/** The header tooltips spelling out each abbreviation, shared with the print table. */
const TITLES: ReadonlyMap<string, string> = new Map(LEG_COLUMNS.map((c) => [c.key, c.title]))

/** The grid's height before the region is measured (and in tests, which have no layout). */
const FALLBACK_HEIGHT_PX = 320

/**
 * The region's height in pixels. pretable virtualizes rows against a numeric
 * `viewportHeight` rather than its container, so the grid fills its scroll
 * region by measuring it.
 */
function useRegionHeight() {
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(FALLBACK_HEIGHT_PX)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null || typeof ResizeObserver === "undefined") return
    const measure = () => {
      if (element.clientHeight > 0) setHeight(element.clientHeight)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { ref, height }
}

/** The row a selection sits in (its anchor's), or null when nothing is selected. */
function selectedRowId(selection: {
  readonly ranges: readonly unknown[]
  readonly anchor: { readonly rowId: string } | null
}): string | null {
  return selection.ranges.length === 0 ? null : (selection.anchor?.rowId ?? null)
}

export interface NavlogGridProps {
  readonly navlog: Navlog
  /** The selected leg (by index), or null when the selection clears: the map highlights it. */
  readonly onSelectLeg: (index: number | null) => void
}

/**
 * The navlog's legs in pretable: the desktop sheet's primary element. Scrolls
 * inside its own region; the print copy is `NavlogTable` (pretable virtualizes
 * rows, so it cannot print every leg).
 *
 * `PretableSurface` rather than the `Pretable` preset: the preset fixes the
 * viewport at 320px and forwards neither `onSelectionChange` nor
 * `getHeaderCellProps`. The leg comes from the cell selection, because
 * pretable's `onSelectedRowIdChange` reports only whole-row selections (a
 * plain click selects one cell) and is not called when Escape clears it.
 */
export function NavlogGrid({ navlog, onSelectLeg }: NavlogGridProps) {
  const rows = useMemo(
    () => navlog.legs.map((leg, index): LegRow => ({ id: rowId(index), leg })),
    [navlog],
  )
  const region = useRegionHeight()
  const reported = useRef<number | null>(null)
  const report = (id: string | null) => {
    const index = id === null ? null : indexOf(id)
    if (index === reported.current) return
    reported.current = index
    onSelectLeg(index)
  }
  return (
    <div ref={region.ref} className="wb-navlog-grid h-full min-h-0 print:hidden">
      <PretableSurface
        ariaLabel="Navlog legs"
        columns={COLUMNS}
        rows={rows}
        getRowId={(row) => row.id}
        getHeaderCellProps={({ columnId }) => {
          const title = TITLES.get(columnId)
          return title === undefined ? undefined : { title }
        }}
        copyWithHeaders
        selectFocusedRowOnArrowKey
        toolPanel={false}
        viewportHeight={region.height}
        onSelectionChange={(selection) => report(selectedRowId(selection))}
      />
    </div>
  )
}
