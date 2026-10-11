"use client"
import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Whether the B4.run server is reachable, as far as the shell knows.
 *
 * "checking" is the first paint, never "down": nothing but an actual probe
 * through the proxy may set "down", and "checking" (not "up") is the honest
 * starting value — nothing has answered yet, and defaulting to "up" would
 * flash the normal shell for a beat on every load even when B4.run is
 * genuinely down.
 */
export type ServerStatus = "checking" | "up" | "down"

/** How often the connect screen re-probes B4.run while it is showing. */
const SERVER_PROBE_INTERVAL_MS = 5000

/** The allowlisted read this app probes B4.run's own liveness through (see `probeB4Server`). */
const SERVER_PROBE_PATH = "/api/b4/memory/candidates"

/**
 * True if the B4.run server itself answered — not just this Next process.
 *
 * `useCopilotKit().runtimeConnectionStatus` looks like the right predicate
 * and is not: the CopilotKit runtime route (`api/copilotkit/[...path]/route.ts`)
 * runs in the SAME Next process as this page, its `/info` handler enumerates
 * the registered agents, and although `B4HttpAgent.getCapabilities` does
 * contact B4.run, the handler catches a failure there and reports the agent
 * without capabilities, so any failure to reach B4.run along that path is
 * swallowed rather than surfaced. With B4.run completely down,
 * `runtimeConnectionStatus` stays `"connected"` and the empty workbench
 * renders.
 *
 * So this probes through the same-origin proxy (`api/b4/[...path]/route.ts`)
 * instead: `GET /api/b4/memory/candidates` is on the proxy's allowlist
 * (`lib/proxy-allowlist.ts`) and is a cheap read. The proxy's one dedicated
 * "I could not reach B4.run" signal is a 502 with an ECONNREFUSED-shaped body
 * (`route.ts`'s catch branch); any other status — even a B4.run-side error —
 * means the process answered, which is all this needs to know.
 */
export async function probeB4Server(): Promise<boolean> {
  try {
    const response = await fetch(SERVER_PROBE_PATH)
    return response.status !== 502
  } catch {
    // The proxy route itself not responding at all is the same "show the
    // connect screen" situation from the user's point of view.
    return false
  }
}

/**
 * The server's status: one probe on mount, then a poll only while "down".
 * `retry` probes again now (the connect screen's button).
 *
 * Recovery, not just detection: a server that dies mid-session is NOT noticed
 * by this poll; the surface for that is a failed run (see the error-surface
 * note in `AppShell.tsx`). Recovery restores the conversation too: the
 * connect screen unmounted the workbench, and remounting it connects the
 * thread again.
 */
export function useServerStatus(): { readonly status: ServerStatus; readonly retry: () => void } {
  const [status, setStatus] = useState<ServerStatus>("checking")

  // Guards `setStatus` calls whose probe resolves after the shell is gone —
  // the interval below already stops new probes on unmount, but a probe
  // already in flight at that moment still has to be told not to write into
  // unmounted state.
  //
  // RE-ARMED on setup, not just cleared on cleanup. Next 16's App Router runs
  // StrictMode by default (this app sets no `reactStrictMode` key), and
  // StrictMode's dev double-invoke is setup -> cleanup -> setup. A flag whose
  // only write is `= false` in the cleanup would latch false forever on the
  // second setup and pin the status at "checking": with B4.run completely
  // down, the connect screen would never appear in dev.
  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const retry = useCallback(() => {
    void probeB4Server().then((up) => {
      if (isMountedRef.current) setStatus(up ? "up" : "down")
    })
  }, [])

  // The one probe every load gets regardless of status: without it, a
  // freshly mounted shell would sit in "checking" forever.
  useEffect(() => {
    retry()
  }, [retry])

  useEffect(() => {
    if (status !== "down") return
    const id = setInterval(retry, SERVER_PROBE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [status, retry])

  return { status, retry }
}
