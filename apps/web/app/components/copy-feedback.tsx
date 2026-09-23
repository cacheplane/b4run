"use client"

import { useCallback, useEffect, useRef, useState } from "react"

export type CopyState = "idle" | "copied" | "error"

const RESET_MS = 2000

/**
 * Write text to the clipboard, reporting failure instead of throwing. Text
 * that is still loading goes through a `ClipboardItem` promise where one is
 * supported, so the write keeps the click's user activation (Safari drops it
 * across an `await`).
 */
export async function writeClipboard(text: string | Promise<string>): Promise<boolean> {
  try {
    const clipboard = navigator.clipboard
    if (!clipboard) return false
    if (typeof text !== "string" && typeof ClipboardItem !== "undefined" && clipboard.write) {
      const blob = text.then((value) => new Blob([value], { type: "text/plain" }))
      try {
        await clipboard.write([new ClipboardItem({ "text/plain": blob })])
        return true
      } catch {
        // Fall through: some browsers reject promise-valued items.
      }
    }
    if (!clipboard.writeText) return false
    await clipboard.writeText(await text)
    return true
  } catch {
    return false
  }
}

/**
 * Copy-to-clipboard with a result the UI can show and announce: `copied` or
 * `error` for two seconds, then back to `idle`.
 */
export function useCopyFeedback(): {
  readonly state: CopyState
  readonly copy: (text: string | Promise<string>) => Promise<boolean>
} {
  const [state, setState] = useState<CopyState>("idle")
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = useCallback(async (text: string | Promise<string>) => {
    const ok = await writeClipboard(text)
    window.clearTimeout(timer.current)
    setState(ok ? "copied" : "error")
    timer.current = window.setTimeout(() => setState("idle"), RESET_MS)
    return ok
  }, [])
  return { state, copy }
}

export const COPY_MESSAGES: Record<CopyState, string> = {
  idle: "",
  copied: "Copied",
  error: "Copy failed",
}

/**
 * A live region that is always in the DOM (so assistive tech is listening
 * before the text changes) and shows the copy result while there is one.
 */
export function CopyStatus({
  state,
  messages = COPY_MESSAGES,
  showSuccess = true,
  className,
}: {
  readonly state: CopyState
  readonly messages?: Record<CopyState, string>
  /** `false` when the trigger already shows success itself; failures always show. */
  readonly showSuccess?: boolean
  readonly className?: string
}) {
  const hidden = state === "idle" || (state === "copied" && !showSuccess)
  return (
    <span
      role="status"
      data-copy-status={state}
      className={`${hidden ? "sr-only" : ""} ${
        state === "error" ? "text-danger" : ""
      } ${className ?? ""}`}
    >
      {messages[state]}
    </span>
  )
}
