"use client"
import { useEffect, useRef } from "react"
import { checkThreadAccess, type ThreadAccess } from "./thread-access"
import type { ThreadSource, WorkbenchThread } from "./thread-source"

export interface ForgetRefusedThreadOptions {
  /** The sidebar's thread list; `null` until the browser has one (SSR). */
  readonly source: ThreadSource | null
  readonly threads: readonly WorkbenchThread[]
  readonly activeThreadId: string | undefined
  /** Called after a refused thread is forgotten, with the thread to open instead. */
  readonly onForgotten: (next: WorkbenchThread) => void
  /** The access check; `checkThreadAccess` unless a test supplies one. */
  readonly check?: (id: string, signal: AbortSignal) => Promise<ThreadAccess>
}

/**
 * Forgets a thread this browser remembers but the server no longer serves to
 * this visitor (the visitor cookie was cleared), when it is opened, and hands
 * back the thread to open instead. See `thread-access.ts` for why the list and
 * ownership can part.
 *
 * Asked once per opening (a load or a pick in the sidebar), and only about a
 * thread that already had a title then: an untitled one has never run, so the
 * server has no record of it yet. Never because a thread just gained its
 * title: that happens as its first message is sent, before the run has created
 * the thread on the server, and the answer would be a 404 for a conversation
 * that is about to exist. So the title is read through a ref, and only a
 * change of thread runs the check.
 */
export function useForgetRefusedThread({
  source,
  threads,
  activeThreadId,
  onForgotten,
  check = checkThreadAccess,
}: ForgetRefusedThreadOptions): void {
  const threadsRef = useRef(threads)
  threadsRef.current = threads
  const onForgottenRef = useRef(onForgotten)
  onForgottenRef.current = onForgotten
  const checkRef = useRef(check)
  checkRef.current = check

  useEffect(() => {
    if (source === null || activeThreadId === undefined) return
    const opened = threadsRef.current.find((thread) => thread.id === activeThreadId)
    if (opened?.title === undefined) return
    const controller = new AbortController()
    void checkRef.current(activeThreadId, controller.signal).then((access) => {
      if (access !== "refused" || controller.signal.aborted) return
      source.remove(activeThreadId)
      onForgottenRef.current(source.list()[0] ?? source.create())
    })
    return () => controller.abort()
  }, [source, activeThreadId])
}
