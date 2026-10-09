// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, test, vi } from "vitest"
import { LEG_COLUMNS } from "../lib/navlog-columns"
import { SAMPLE_NAVLOG } from "../lib/navlog-types"

interface Selection {
  ranges: { startRowId: string; endRowId: string; startColumnId: string; endColumnId: string }[]
  anchor: { rowId: string; columnId: string } | null
}

const grid = vi.hoisted(
  () =>
    ({}) as {
      props?: {
        ariaLabel: string
        columns: {
          id: string
          header?: string
          pinned?: string
          sortable?: boolean
          filterable?: boolean
          align?: string
        }[]
        rows: { id: string }[]
        getRowId: (row: { id: string }) => string
        getHeaderCellProps?: (input: { columnId: string }) => { title?: string } | undefined
        onSelectionChange?: (selection: Selection) => void
        selectFocusedRowOnArrowKey?: boolean
        copyWithHeaders?: boolean
        toolPanel?: unknown
        viewportHeight: number
      }
    },
)
vi.mock("@pretable/react", () => ({
  PretableSurface: (props: NonNullable<typeof grid.props>) => {
    grid.props = props
    return <div data-testid="pretable" />
  },
}))

const { NavlogGrid } = await import("./NavlogGrid")
const { NavlogSheet } = await import("./NavlogSheet")

function mount(onSelectLeg = vi.fn()) {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(<NavlogGrid navlog={SAMPLE_NAVLOG} onSelectLeg={onSelectLeg} />))
  return { container, onSelectLeg, unmount: () => act(() => root.unmount()) }
}

/** A selection of one cell (or a row's cells) in `rowId`. */
const inRow = (rowId: string): Selection => ({
  ranges: [{ startRowId: rowId, endRowId: rowId, startColumnId: "leg", endColumnId: "leg" }],
  anchor: { rowId, columnId: "leg" },
})

describe("NavlogGrid", () => {
  test("Leg pinned left, then the figures, end-aligned; no sort or filter", () => {
    const view = mount()
    const columns = grid.props?.columns ?? []
    expect(columns[0]).toMatchObject({ id: "leg", header: "Leg", pinned: "left" })
    expect(columns.slice(1).map((c) => c.header)).toEqual(LEG_COLUMNS.map((c) => c.label))
    expect(columns.slice(1).every((c) => c.align === "end")).toBe(true)
    expect(columns.every((c) => c.sortable === false && c.filterable === false)).toBe(true)
    expect(grid.props?.ariaLabel).toBe("Navlog legs")
    expect(grid.props?.copyWithHeaders).toBe(true)
    expect(grid.props?.toolPanel).toBe(false)
    expect(grid.props?.viewportHeight).toBeGreaterThan(0)
    view.unmount()
  })
  test("headers spell out their abbreviations, as the print table does", () => {
    const view = mount()
    expect(grid.props?.getHeaderCellProps?.({ columnId: "mh" })).toEqual({
      title: "Magnetic heading",
    })
    expect(grid.props?.getHeaderCellProps?.({ columnId: "leg" })).toBeUndefined()
    view.unmount()
  })
  test("one row per leg, in route order", () => {
    const view = mount()
    expect(grid.props?.rows).toHaveLength(SAMPLE_NAVLOG.legs.length)
    expect(grid.props?.rows.map((r) => grid.props?.getRowId(r))).toEqual(
      SAMPLE_NAVLOG.legs.map((_, i) => `leg-${i}`),
    )
    view.unmount()
  })
  test("selecting in a row reports its leg index; clearing reports null", () => {
    const view = mount()
    expect(grid.props?.selectFocusedRowOnArrowKey).toBe(true)
    act(() => grid.props?.onSelectionChange?.(inRow("leg-1")))
    expect(view.onSelectLeg).toHaveBeenLastCalledWith(1)
    act(() => grid.props?.onSelectionChange?.({ ranges: [], anchor: null }))
    expect(view.onSelectLeg).toHaveBeenLastCalledWith(null)
    view.unmount()
  })
  test("reports only changes of leg, not every selection change within one", () => {
    const view = mount()
    act(() => grid.props?.onSelectionChange?.(inRow("leg-2")))
    act(() => grid.props?.onSelectionChange?.(inRow("leg-2")))
    expect(view.onSelectLeg).toHaveBeenCalledTimes(1)
    view.unmount()
  })
  test("a replan remounts the grid, so re-selecting the same leg reports it again", () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    const onSelectLeg = vi.fn()
    const sheet = (navlog: typeof SAMPLE_NAVLOG) => (
      <NavlogSheet
        navlog={navlog}
        brief=""
        open={true}
        onToggle={() => {}}
        tab="legs"
        onTabChange={() => {}}
        onSelectLeg={onSelectLeg}
      />
    )
    act(() => root.render(sheet(SAMPLE_NAVLOG)))
    act(() => grid.props?.onSelectionChange?.(inRow("leg-2")))
    expect(onSelectLeg).toHaveBeenLastCalledWith(2)
    // The layout clears its selected leg on a new navlog; the grid starts over too.
    act(() => root.render(sheet({ ...SAMPLE_NAVLOG, legs: [...SAMPLE_NAVLOG.legs] })))
    act(() => grid.props?.onSelectionChange?.(inRow("leg-2")))
    expect(onSelectLeg).toHaveBeenCalledTimes(2)
    expect(onSelectLeg).toHaveBeenLastCalledWith(2)
    // Re-rendering the same navlog keeps the grid as it is: no second report.
    const replanned = { ...SAMPLE_NAVLOG, legs: [...SAMPLE_NAVLOG.legs] }
    act(() => root.render(sheet(replanned)))
    act(() => grid.props?.onSelectionChange?.(inRow("leg-2")))
    act(() => root.render(sheet(replanned)))
    act(() => grid.props?.onSelectionChange?.(inRow("leg-2")))
    expect(onSelectLeg).toHaveBeenCalledTimes(3)
    act(() => root.unmount())
    container.remove()
  })
})
