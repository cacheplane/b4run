"use client"
import { useB4ActivityContext } from "@b4run/ag-ui/react/copilotkit"
import { useAgent, useCopilotKit } from "@copilotkit/react-core/v2"
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react"
import {
  isAwaitingApproval,
  latestNavlogResult,
  type MessageLike,
  navlogAnswerText,
  parseNavlog,
} from "../lib/navlog-selectors"
import { latestRouteStations, type RouteStation } from "../lib/weather-roles"
import { latestWeatherBriefText, parseWeatherBrief } from "../lib/weather-selectors"
import { NavlogChat } from "./NavlogChat"
import { type MemoryControls, WorkbenchLayout } from "./WorkbenchLayout"

export interface ThreadWorkbenchProps {
  /** The thread on screen; the chat waits for it to resolve. */
  readonly threadId: string | undefined
  readonly canAttachImages: boolean
  /** The thread's title, for the chat dock's header. */
  readonly header: string
  /** The shell's failure banner (`RunError`), or nothing. */
  readonly banner: ReactNode
  /** The content-parts-dropped notices (`DropNotices`). */
  readonly notices: ReactNode
  /** The thread list (`ThreadRail`), for the sidenav. */
  readonly rail: ReactNode
  /** The memory review (`MemoryPanel`), given Memory mode's state. */
  readonly memory: (controls: MemoryControls) => ReactNode
  /** Memory candidates waiting, for the sidenav's count. */
  readonly memoryCount: number
  readonly onNewConversation: () => void
}

/** No stations yet: one shared empty list, so the map's input keeps its identity. */
const NO_STATIONS: readonly RouteStation[] = []

/**
 * The workbench for one thread, rendered inside `AppShell`'s keyed
 * `B4Activity`: it reads the thread's turns into the navlog, the weather
 * brief, the stations and the planning answer, and hands them with the chat
 * (`NavlogChat`) to `WorkbenchLayout`.
 *
 * The selectors return STRINGS and the parse is memoized on them. The turns
 * are rebuilt on every streamed event; parsing afresh each time would give the
 * map a new `Navlog` object per token, and the map refits whenever its
 * geometry changes. A tool result's text never changes once it has arrived, so
 * keying on it gives one object per computation.
 */
export function ThreadWorkbench({
  threadId,
  canAttachImages,
  header,
  banner,
  notices,
  rail,
  memory,
  memoryCount,
  onNewConversation,
}: ThreadWorkbenchProps) {
  const { turns } = useB4ActivityContext()
  const { agent } = useAgent()
  const { copilotkit } = useCopilotKit()
  const navlogRef = latestNavlogResult(turns)
  const navlogText = navlogRef?.result
  const navlog = useMemo(
    () => (navlogText === undefined ? null : parseNavlog(navlogText)),
    [navlogText],
  )
  const weatherText = latestWeatherBriefText(turns)
  const weatherBrief = useMemo(
    () => (weatherText === null ? null : parseWeatherBrief(weatherText)),
    [weatherText],
  )
  // Keyed on the result text like the navlog, so the map's stations keep
  // their identity across streamed events and its markers are not redrawn.
  const stationsKey = JSON.stringify(latestRouteStations(turns))
  const stations = useMemo((): readonly RouteStation[] => {
    const list = JSON.parse(stationsKey) as RouteStation[]
    return list.length === 0 ? NO_STATIONS : list
  }, [stationsKey])
  // The answer of the turn that produced the navlog on screen, not whatever
  // the latest reply is (a later "Filed." must not replace the planning answer).
  const planningAnswer =
    navlogRef === null
      ? ""
      : navlogAnswerText(agent.messages as readonly MessageLike[], navlogRef.id)
  // The badge says "running" for a run, never for a restore. `agent.isRunning`
  // cannot tell them apart: `connectAgent` holds it for the whole replay, so
  // every thread opened would read "running". The turns can: a turn is
  // `working` from its `RUN_STARTED` until it settles, and a replayed run that
  // already finished replays its settle too. The one gap is a send's first
  // beat — `CopilotChat` adds the message and starts the run, but the turn
  // appears only once `RUN_STARTED` comes back — so a user message added here
  // (`onNewMessage` fires for a send, never for a replay) counts as running
  // until that event, or the run's end if it fails before it. The send button
  // keeps `agent.isRunning` (see `NavlogChat`), because that is what decides
  // what clicking it does.
  const [sendPending, setSendPending] = useState(false)
  useEffect(() => {
    const settle = () => setSendPending(false)
    const subscription = agent.subscribe({
      onNewMessage: ({ message }) => {
        if (message.role === "user") setSendPending(true)
      },
      onRunStartedEvent: settle,
      onRunFailed: settle,
      onRunFinalized: settle,
    })
    return () => {
      subscription.unsubscribe()
    }
  }, [agent])
  const status =
    sendPending || turns.turns.at(-1)?.status === "working"
      ? "running"
      : isAwaitingApproval(turns)
        ? "awaiting approval"
        : undefined

  // The route bar's Replan: an ordinary user message, sent the way
  // `CopilotChat` sends one (`agent.addMessage` with a string content, then
  // `copilotkit.runAgent`), so it reads the same in the transcript, touches
  // the rail through `onNewMessage` and shows Running at once. A failed run
  // does not reject: `runAgent` reports it through `emitError`, which the
  // shell's `copilotkit.subscribe` seam turns into the RunError banner. The
  // catch only keeps an unexpected throw from going unhandled, as
  // `CopilotChat` does.
  const onReplan = useCallback(
    (text: string) => {
      agent.addMessage({ id: crypto.randomUUID(), role: "user", content: text })
      copilotkit.runAgent({ agent }).catch((error: unknown) => {
        console.error("ThreadWorkbench: Replan runAgent failed", error)
      })
    },
    [agent, copilotkit],
  )

  return (
    <WorkbenchLayout
      navlog={navlog}
      weatherBrief={weatherBrief}
      stations={stations}
      // A parked approval blocks a new run too: the next run would throw
      // ("pending interrupt(s) not addressed by resume"), so Replan waits.
      running={status !== undefined}
      onReplan={onReplan}
      planningAnswer={planningAnswer}
      header={header}
      status={status}
      rail={rail}
      memory={memory}
      memoryCount={memoryCount}
      banner={banner}
      notices={notices}
      onNewConversation={onNewConversation}
      // Only once the thread id resolves: without one, `CopilotChat` mints a
      // random thread and connects to it.
      chat={
        threadId === undefined ? null : (
          <NavlogChat threadId={threadId} canAttachImages={canAttachImages} />
        )
      }
    />
  )
}
