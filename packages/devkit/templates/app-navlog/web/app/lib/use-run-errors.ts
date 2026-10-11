"use client"
import { useCopilotKit } from "@copilotkit/react-core/v2"
import { useCallback, useEffect, useRef, useState } from "react"
import type { ServerStatus } from "./use-server-status"

/**
 * Which CopilotKit core errors are the user's problem, and what to call them.
 *
 * `onError` fires for the whole `CopilotKitCoreErrorCode` enum, not just runs:
 * transcription failures, tool-registration mistakes, and
 * `subscriber_callback_failed` — a bug thrown by one of *our* renderers — all
 * arrive on the same channel. Showing every one of them as "The run failed" is
 * a lie in both directions, so this is an allowlist, and anything absent stays
 * a console line.
 *
 * Keyed by the enum's string values rather than the enum itself: importing
 * `@copilotkit/core` for a comparison would add a direct dependency on a
 * package this app only has transitively, and TypeScript refuses to compare an
 * enum-typed value against a string literal anyway.
 */
export const RUN_ERROR_TITLES: Readonly<Record<string, string>> = {
  agent_run_failed: "The run failed",
  agent_run_failed_event: "The run failed",
  agent_run_error_event: "The run failed",
  // `CopilotChat` connects the thread on mount, and the runtime route restores
  // it from B4.run's storage: a failure here is the conversation not loading.
  agent_connect_failed: "Couldn't load this conversation",
  agent_thread_locked: "This conversation is already running",
  agent_not_found: "The navlog agent is not registered",
  // NOT "Cannot reach the B4.run server" — this code means `/api/copilotkit`'s
  // own `/info` sync broke inside the Next process, which is a different
  // failure from B4.run being down (see `probeB4Server`'s comment for why
  // that route cannot tell the two apart at all).
  runtime_info_fetch_failed: "The chat runtime failed to initialize",
}

/** The codes whose banner offers Retry: loading the conversation again can help. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(["agent_connect_failed"])

/** The failure the `RunError` banner shows. */
export interface RunErrorState {
  readonly title: string
  readonly message: string
  readonly retryable: boolean
}

export interface RunErrors {
  /** The banner's content, or null for no banner. */
  readonly runError: RunErrorState | null
  /**
   * Bumped by `retry`. The shell keys the workbench on it, so a retry
   * remounts the chat, which connects the thread again.
   */
  readonly connectNonce: number
  /** Drops the banner (its dismiss button, and a thread switch). */
  readonly clear: () => void
  /** Drops the banner and connects the thread again. */
  readonly retry: () => void
}

/**
 * Run and load failures, for the `RunError` banner (surface 2 of the
 * error-surface note in `AppShell.tsx`).
 *
 * Takes the server status only to forget a banner the server's recovery made
 * stale.
 */
export function useRunErrors(serverStatus: ServerStatus): RunErrors {
  const { copilotkit } = useCopilotKit()
  const [runError, setRunError] = useState<RunErrorState | null>(null)
  const [connectNonce, setConnectNonce] = useState(0)

  // THE seam for run and load failures. `copilotkit.runAgent` and
  // `connectAgent` do not reject when they fail: they catch, call
  // `emitError`, and resolve. Errors surface only here, as
  // `CopilotKitCoreErrorCode` events.
  useEffect(() => {
    const subscription = copilotkit.subscribe({
      onError: ({ error, code }) => {
        const title = RUN_ERROR_TITLES[String(code)]
        if (title === undefined) {
          console.error(`AppShell: unshown CopilotKit error (${String(code)})`, error)
          return
        }
        setRunError({ title, message: error.message, retryable: RETRYABLE_CODES.has(String(code)) })
      },
    })
    return () => {
      subscription.unsubscribe()
    }
  }, [copilotkit])

  // A banner raised while the server was down (a load that failed because
  // B4.run was gone) is stale once it is back: recovery remounts the
  // workbench, which connects the thread again on its own.
  const previousServerStatusRef = useRef(serverStatus)
  useEffect(() => {
    if (previousServerStatusRef.current === "down" && serverStatus === "up") setRunError(null)
    previousServerStatusRef.current = serverStatus
  }, [serverStatus])

  const clear = useCallback(() => setRunError(null), [])
  const retry = useCallback(() => {
    setRunError(null)
    setConnectNonce((n) => n + 1)
  }, [])

  return { runError, connectNonce, clear, retry }
}
