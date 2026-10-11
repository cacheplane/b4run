"use client"
import type { useAgent } from "@copilotkit/react-core/v2"
import { useEffect, useRef } from "react"
import { titleFor, type WorkbenchThread } from "./thread-source"

type Agent = Pick<ReturnType<typeof useAgent>["agent"], "messages" | "subscribe">

interface MessageShape {
  readonly id: string
  readonly role: string
  readonly content?: unknown
}

/** The first user message, which titles the thread. */
function firstUserMessage(messages: readonly MessageShape[]): MessageShape | undefined {
  return messages.find((message) => message.role === "user")
}

export interface ThreadTitlesOptions {
  readonly agent: Agent
  readonly activeThreadId: string | undefined
  /** The rail's entry for the active thread, if it has one yet. */
  readonly activeThread: WorkbenchThread | undefined
  /** See `AppShellProps.onUserMessage`: a touch, carrying a title for an untitled thread. */
  readonly onUserMessage: (message: string) => void
}

/**
 * Reports the user's messages to the rail: every send touches the thread
 * (recency), and a restored thread that was never titled is titled once from
 * its first user message.
 *
 * ORDERING: call after `useThreadSwitchReset`. The titling effect reads
 * `agent.messages` when it runs and relies on the reset having already
 * cleared the previous thread's messages on a switch.
 */
export function useThreadTitles({
  agent,
  activeThreadId,
  activeThread,
  onUserMessage,
}: ThreadTitlesOptions): void {
  // Rail recency: every message the user sends touches the thread. Read off
  // the agent rather than caught at a send call, because `CopilotChat` sends
  // on its own: its submit and its suggestion pills both go through
  // `agent.addMessage`, which fires `onNewMessage`. A restore does not: the
  // replayed user messages arrive inside `RUN_STARTED.input`, which
  // `@ag-ui/client` merges into the messages without `onNewMessage`, so
  // opening an old conversation never moves it up the rail. `onNewMessage`
  // also fires for assistant messages (at `TEXT_MESSAGE_END`), hence the role
  // check, and ids are deduped per subscription so a message reported twice
  // touches once. The callback is read through a ref so a new `onUserMessage`
  // (it closes over the active thread id) does not resubscribe.
  const onUserMessageRef = useRef(onUserMessage)
  onUserMessageRef.current = onUserMessage
  const touchedIdsRef = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const touched = new Set<string>()
    touchedIdsRef.current = touched
    const subscription = agent.subscribe({
      onNewMessage: ({ message }) => {
        if (message.role !== "user" || touched.has(message.id)) return
        touched.add(message.id)
        onUserMessageRef.current(titleFor(message.content))
      },
    })
    return () => {
      subscription.unsubscribe()
    }
  }, [agent])

  // Titles a RESTORED thread that was never titled (the conversation exists
  // on B4.run but the rail has no title for it), once the replay lands. A
  // thread whose first message was sent here was titled by the touch above,
  // so a first user message that subscription already reported is skipped.
  //
  // The messages are read when the effect runs, not at render: on a switch the
  // render still saw the previous thread's messages, and the reset has run by
  // now (see ORDERING above). `firstUserContent` is a dependency only so the
  // effect runs again when the first user message arrives.
  const titledRef = useRef<string | undefined>(undefined)
  const firstUserContent = firstUserMessage(agent.messages)?.content
  useEffect(() => {
    void firstUserContent
    if (activeThreadId === undefined || activeThread === undefined) return
    if (activeThread.title !== undefined || titledRef.current === activeThreadId) return
    const first = firstUserMessage(agent.messages)
    if (first === undefined || touchedIdsRef.current.has(first.id)) return
    const title = titleFor(first.content)
    if (title.length === 0) return
    titledRef.current = activeThreadId
    onUserMessageRef.current(title)
  }, [activeThreadId, activeThread, agent, firstUserContent])
}
