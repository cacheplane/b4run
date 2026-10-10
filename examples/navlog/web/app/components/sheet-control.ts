"use client"
import { createContext } from "react"

/**
 * How a view inside the chat brings the navlog sheet into view: on a desktop
 * it opens the sheet under the map, on a phone the navlog tab is selected.
 * `WorkbenchLayout` provides it; outside the layout (a test, a bare chat) it
 * does nothing.
 */
export interface SheetControl {
  readonly openSheet: () => void
}

/** The sheet control `WorkbenchLayout` provides; a no-op outside it. */
export const SheetControlContext = createContext<SheetControl>({ openSheet: () => {} })
