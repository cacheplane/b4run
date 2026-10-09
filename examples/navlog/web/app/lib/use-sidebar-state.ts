"use client"
import { useCallback, useEffect, useState } from "react"

/** Where the desktop sidebar's expanded/collapsed choice lives, per browser. */
export const SIDEBAR_STORAGE_KEY = "b4.workbench.sidebar"

export type SidebarState = "expanded" | "collapsed"

/** The stored state; anything missing, unknown or unreadable is expanded. */
export function readSidebarState(storage: Pick<Storage, "getItem"> | undefined): SidebarState {
  try {
    return storage?.getItem(SIDEBAR_STORAGE_KEY) === "collapsed" ? "collapsed" : "expanded"
  } catch {
    return "expanded"
  }
}

/**
 * The browser's `localStorage`, or nothing. Reading the global itself can
 * throw (a SecurityError when site data is blocked, or in a sandboxed iframe),
 * so even the lookup sits inside the try.
 */
function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined
  } catch {
    return undefined
  }
}

/**
 * The sidebar's state and its toggle. Starts expanded and reads storage after
 * mount, so the server render and the first client render agree; a stored
 * "collapsed" applies one frame later.
 */
export function useSidebarState(): readonly [SidebarState, () => void] {
  const [state, setState] = useState<SidebarState>("expanded")
  useEffect(() => {
    setState(readSidebarState(safeStorage()))
  }, [])
  const toggle = useCallback(() => {
    const next: SidebarState = state === "expanded" ? "collapsed" : "expanded"
    setState(next)
    try {
      safeStorage()?.setItem(SIDEBAR_STORAGE_KEY, next)
    } catch {
      // Storage blocked (private mode, quota): the choice lasts this page only.
    }
  }, [state])
  return [state, toggle] as const
}
