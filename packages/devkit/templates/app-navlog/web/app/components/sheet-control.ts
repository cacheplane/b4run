"use client"
import { createContext } from "react"

/**
 * How a view inside the chat brings the navlog sheet into view: on a desktop
 * it opens the sheet under the map, on a phone the navlog tab is selected.
 * Each layout (`DesktopWorkbench`, `PhoneWorkbench`) provides its own;
 * outside them (a test, a bare chat) it does nothing.
 */
export interface SheetControl {
  readonly openSheet: () => void
}

/** The sheet control a layout provides; a no-op outside one. */
export const SheetControlContext = createContext<SheetControl>({ openSheet: () => {} })
