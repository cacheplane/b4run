"use client"
import type { useAgent } from "@copilotkit/react-core/v2"
import { useEffect, useRef } from "react"

type Agent = Pick<
  ReturnType<typeof useAgent>["agent"],
  "isRunning" | "abortRun" | "pendingInterrupts" | "setMessages"
>

/**
 * Resets the SHARED agent when the active thread changes, then calls
 * `onSwitch` for the caller's own per-thread state (the error banner, the
 * drop notices).
 *
 * The shell's keyed `B4Activity` remounts the chat, which connects the new
 * thread; what lives on the shared agent does not go with it. Clearing
 * `pendingInterrupts` here is a safety net: CopilotKit's `connectAgent`
 * already clears them when the thread changes, but a parked interrupt from
 * the abandoned thread would make the next run throw ("pending interrupt(s)
 * not addressed by resume"), so the shell does not depend on that ordering.
 * The messages are cleared too, so the thread's title and the selectors never
 * read the previous thread's history in the beat before the replay lands.
 * Child effects run before this one, but the chat's connect is asynchronous,
 * so the clear lands before its replay.
 *
 * ORDERING: call this before any hook whose effects read `agent.messages`
 * for the new thread (`useThreadTitles`). Effects run in call order within a
 * commit, so a later hook's effect sees the cleared list on a switch.
 *
 * The ref keeps an agent swap (the provisional stand-in replaced by the
 * runtime's agent after `/info`) from counting as a switch. `onSwitch` is
 * read through a ref, so an inline callback does not re-run the effect.
 */
export function useThreadSwitchReset(
  agent: Agent,
  activeThreadId: string | undefined,
  onSwitch: () => void,
): void {
  const onSwitchRef = useRef(onSwitch)
  onSwitchRef.current = onSwitch
  const renderedThreadIdRef = useRef(activeThreadId)
  useEffect(() => {
    if (renderedThreadIdRef.current === activeThreadId) return
    renderedThreadIdRef.current = activeThreadId
    if (agent.isRunning) agent.abortRun()
    agent.pendingInterrupts = []
    agent.setMessages([])
    onSwitchRef.current()
  }, [activeThreadId, agent])
}
