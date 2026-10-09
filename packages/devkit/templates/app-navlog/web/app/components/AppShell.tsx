"use client"
import { B4Activity, useB4ActivityContext } from "@b4run/ag-ui/react/copilotkit"
import { useAgent, useCapabilities, useCopilotKit } from "@copilotkit/react-core/v2"
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  isAwaitingApproval,
  latestNavlogResult,
  type MessageLike,
  navlogAnswerText,
  parseNavlog,
} from "../lib/navlog-selectors"
import { titleFor, type WorkbenchThread } from "../lib/thread-source"
import { latestWeatherBriefText, parseWeatherBrief } from "../lib/weather-selectors"
import { ConnectScreen } from "./ConnectScreen"
import { type DropNotice, DropNotices } from "./DropNotices"
import { MemoryPanel } from "./MemoryPanel"
import { NavlogChat } from "./NavlogChat"
import { RunError } from "./RunError"
import { NAVLOG_STEP_LABELS, NAVLOG_STEP_RENDERERS } from "./StepViews"
import { ThreadRail, UNTITLED_THREAD_LABEL } from "./ThreadRail"
import { type MemoryControls, WorkbenchLayout } from "./WorkbenchLayout"

/**
 * THE ERROR-SURFACE NOTE. Three surfaces can report a failure in this app, and
 * they are stated once here so the sites that implement them can cite this
 * instead of each re-arguing why they are not the others.
 *
 * 1. `ConnectScreen` — the server is KNOWN to be down: a probe through the
 *    proxy came back 502 (`probeB4Server`). It replaces the entire shell,
 *    because nothing in the shell works without a server.
 * 2. The `RunError` banner in the chat dock — something failed while the shell
 *    is UP and there is a conversation on screen to attach it to: a run, a
 *    resume, or loading the conversation (`RUN_ERROR_TITLES`, via the
 *    `copilotkit.subscribe` seam below). A failed load offers Retry.
 * 3. The memory panel's quiet muted line — `MemoryPanel`'s own candidate read
 *    failing for a reason that is NOT a 502. A 502 there is surface 1's fact,
 *    so the panel stays silent for it rather than competing.
 *
 * The rule that generates all three: report a fact once, on the surface that
 * owns it, at the size of the thing that broke.
 */

/**
 * The default `api/copilotkit/[...path]/route.ts` and `api/b4/[...path]/route.ts` fall
 * back to when `B4_SERVER_URL` is unset. Those two are the SHAREABLE copies
 * — one source, read from the env at request time on the server. This one is
 * not: it ships inside the client bundle, can only ever be a literal, and
 * only coincides with the real value because both default the same env var
 * the same way. A client component cannot read `B4_SERVER_URL` itself (it
 * is server-side only), and this app has deliberately not grown a
 * `NEXT_PUBLIC_` twin for it (a second value that can drift from the real one
 * is worse than an honest default). `ConnectScreen` shows this value labeled
 * as a default, not asserted as the confirmed target.
 */
const DEFAULT_SERVER_URL = "http://127.0.0.1:3002"

/** How often the connect screen re-probes B4.run while it is showing. */
const SERVER_PROBE_INTERVAL_MS = 5000

/** The allowlisted read this app probes B4.run's own liveness through (see `probeB4Server`). */
const SERVER_PROBE_PATH = "/api/b4/memory/candidates"

/**
 * True if the B4.run server itself answered — not just this Next process.
 *
 * `useCopilotKit().runtimeConnectionStatus` looks like the right predicate
 * and is not, which is what shipped here first and was caught live: the
 * CopilotKit runtime route (`api/copilotkit/[...path]/route.ts`) runs in the SAME Next
 * process as this page, its `/info` handler enumerates the registered
 * agents, and although `B4HttpAgent.getCapabilities` does contact B4.run,
 * the handler catches a failure there and reports the agent without
 * capabilities, so any failure to reach B4.run along that path is
 * swallowed rather than surfaced. Verified live: with B4.run completely down,
 * `runtimeConnectionStatus` stayed `"connected"`, the empty workbench
 * rendered, and no connect screen ever showed.
 *
 * So this probes through the same-origin proxy (`api/b4/[...path]/route.ts`)
 * instead: `GET /api/b4/memory/candidates` is on the proxy's allowlist
 * (`lib/proxy-allowlist.ts`) and is a cheap read. The proxy's one dedicated
 * "I could not reach B4.run" signal is a 502 with an ECONNREFUSED-shaped body
 * (`route.ts`'s catch branch); any other status — even a B4.run-side error —
 * means the process answered, which is all this needs to know.
 */
async function probeB4Server(): Promise<boolean> {
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

/** The `CUSTOM` event name `packages/langchain` emits when parts never reached the model. */
const CONTENT_PARTS_DROPPED_EVENT = "b4.content_parts_dropped"

/**
 * A `b4.content_parts_dropped` value as far as the notices need it: a `parts`
 * list of `{ type, reason }` entries. The event crosses the network, so it is
 * checked rather than cast; a payload that fails is dropped quietly (the
 * notice is a courtesy, not the run's outcome).
 */
function asDropNotice(value: unknown): DropNotice | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { parts, toolCallId } = value as { parts?: unknown; toolCallId?: unknown }
  if (!Array.isArray(parts) || parts.length === 0) return undefined
  const valid = parts.every(
    (part) =>
      typeof part === "object" &&
      part !== null &&
      typeof (part as { type?: unknown }).type === "string" &&
      typeof (part as { reason?: unknown }).reason === "string",
  )
  if (!valid) return undefined
  if (toolCallId !== undefined && typeof toolCallId !== "string") return undefined
  return value as DropNotice
}

interface MessageShape {
  readonly id: string
  readonly role: string
  readonly content?: unknown
}

/** The first user message, which titles the thread. */
function firstUserMessage(messages: readonly MessageShape[]): MessageShape | undefined {
  return messages.find((message) => message.role === "user")
}

interface RunErrorState {
  readonly title: string
  readonly message: string
  readonly retryable: boolean
}

export interface AppShellProps {
  readonly threads: readonly WorkbenchThread[]
  readonly activeThreadId: string | undefined
  readonly onSelectThread: (threadId: string) => void
  readonly onCreateThread: () => void
  /**
   * Reported for every message the user sends in the active thread (a typed
   * submit or a suggestion pill), so the rail can move the thread to the top;
   * the argument is that message's title text (`titleFor`), which titles the
   * thread if it has no title yet and is otherwise ignored. A restore reports
   * nothing — replaying a conversation is not activity in it — except once,
   * with the first user message, for a restored thread that was never titled.
   */
  readonly onUserMessage: (message: string) => void
}

/**
 * The shell: the server probe, the failure banner, drop notices, thread
 * titling, and the keyed `B4Activity` the workbench lives in.
 *
 * `useAgent()` is deliberately called with NO arguments. Its props have exactly
 * two legal shapes: unscoped (`useAgent()` / `useAgent({ agentId })`), which
 * takes its thread from the surrounding chat configuration, or thread-scoped
 * (`{ agentId, runtimeAgentId, threadId }` — all three, or it throws at
 * runtime), which registers a *private proxied* agent. The unscoped form is
 * what this app wants: `CopilotChat`, `B4Activity`'s `useInterrupt` and
 * `useSuggestions` all resolve their agent the same way, so one
 * `CopilotChatConfigurationProvider` (mounted in `page.tsx`) keeps every hook
 * bound to the same agent and the same thread.
 *
 * `B4Activity` is keyed by the thread (finding 6 of the adopt plan):
 * `useInterrupt` clears its pending card only on a new run, so an activity
 * that outlived a switch would show the previous thread's approval card on
 * the next one. The key also restarts the turns from empty, and the remount
 * remounts `CopilotChat`, which connects the new thread — the runtime route
 * replays it from B4.run's storage. `connectNonce` is in the key so Retry on
 * a failed load connects again.
 */
export function AppShell({
  threads,
  activeThreadId,
  onSelectThread,
  onCreateThread,
  onUserMessage,
}: AppShellProps) {
  const { agent } = useAgent()
  const { copilotkit } = useCopilotKit()
  // The route's capability document, as CopilotKit's runtime `/info` sync
  // fetched it from `B4HttpAgent.getCapabilities()` — in the browser the agent
  // is the runtime's proxy, so this hook (not a direct `getCapabilities()`
  // call) is how the page reads it. `undefined` until the handshake lands,
  // which correctly hides the attach control until then.
  const capabilities = useCapabilities()
  const canAttachImages = capabilities?.multimodal?.input?.image === true
  // Drop notices for the thread on screen, in arrival order. Not on the
  // agent: CopilotKit keeps no record of CUSTOM events, so this list is the
  // only place they live, and it goes with the thread on a switch.
  const [notices, setNotices] = useState<readonly DropNotice[]>([])
  const [runError, setRunError] = useState<RunErrorState | null>(null)
  const [connectNonce, setConnectNonce] = useState(0)
  // Memory candidates waiting, reported by `MemoryPanel`, for the sidenav's count.
  const [memoryCount, setMemoryCount] = useState(0)

  // "checking" first paint, never "down" — see `probeB4Server` and the
  // effects below for why nothing but an actual probe through the proxy may
  // set this to "down", and why "checking" (not "up") is the honest starting
  // value: nothing has answered yet, and defaulting to "up" would flash the
  // normal shell for a beat on every load even when B4.run is genuinely down.
  const [serverStatus, setServerStatus] = useState<"checking" | "up" | "down">("checking")
  // Guards `setServerStatus` calls whose probe resolves after this component
  // is gone — the interval below already stops new probes on unmount, but a
  // probe already in flight at that moment still has to be told not to write
  // into unmounted state.
  //
  // RE-ARMED on setup, not just cleared on cleanup, and that is a bug fix
  // rather than symmetry-for-its-own-sake. Next 16's App Router runs
  // StrictMode by default (this app sets no `reactStrictMode` key), and
  // StrictMode's dev double-invoke is setup -> cleanup -> setup. A flag whose
  // only write is `= false` in the cleanup latches false forever on the second
  // setup, which pins `serverStatus` at "checking": with B4.run completely down,
  // the connect screen NEVER appears in dev and the shell sits there looking
  // fine. Verified in jsdom against a non-Strict control.
  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const runProbe = useCallback(() => {
    void probeB4Server().then((up) => {
      if (isMountedRef.current) setServerStatus(up ? "up" : "down")
    })
  }, [])

  // The one probe every load gets regardless of status: without it, a
  // freshly mounted shell would sit in "checking" forever.
  useEffect(() => {
    runProbe()
  }, [runProbe])

  // Recovery, not just detection: polls only while "down". A server that dies
  // mid-session is NOT noticed by this poll; the surface for it is a failed
  // run (see the error-surface note at the top of this file). Recovery
  // restores the conversation too: the connect screen unmounted the
  // workbench, and remounting it connects the thread again.
  useEffect(() => {
    if (serverStatus !== "down") return
    const id = setInterval(runProbe, SERVER_PROBE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [serverStatus, runProbe])

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

  // A thread switch. The keyed `B4Activity` remounts the chat, which connects
  // the new thread; what lives on the SHARED agent does not go with it.
  // Clearing `pendingInterrupts` here is a safety net: CopilotKit's
  // `connectAgent` already clears them when the thread changes, but a parked
  // interrupt from the abandoned thread would make the next run throw
  // ("pending interrupt(s) not addressed by resume"), so the shell does not
  // depend on that ordering. The messages are cleared too, so the thread's
  // title and the selectors never read the previous thread's history in the
  // beat before the replay lands. Child effects run before this one, but the
  // chat's connect is asynchronous, so the clear lands before its replay.
  //
  // The ref keeps an agent swap (the provisional stand-in replaced by the
  // runtime's agent after `/info`) from counting as a switch.
  const renderedThreadIdRef = useRef(activeThreadId)
  useEffect(() => {
    if (renderedThreadIdRef.current === activeThreadId) return
    renderedThreadIdRef.current = activeThreadId
    if (agent.isRunning) agent.abortRun()
    agent.pendingInterrupts = []
    agent.setMessages([])
    setRunError(null)
    setNotices([])
  }, [activeThreadId, agent])

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
  const activeThread = threads.find((thread) => thread.id === activeThreadId)
  //
  // The messages are read when the effect runs, not at render: on a switch the
  // render still saw the previous thread's messages, and the clear above has
  // run by now (effects run in order). `firstUserContent` is a dependency
  // only so the effect runs again when the first user message arrives.
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

  // Parts the model never saw (`b4.content_parts_dropped`, emitted by the
  // langchain adapter when the provider or model cannot take a part), as
  // notices in the dock. Same lifecycle as `MemoryPanel`'s
  // `onRunFinishedEvent` subscription: keyed on the agent instance, so a swap
  // re-subscribes the new one and unsubscribes the old.
  useEffect(() => {
    const subscription = agent.subscribe({
      onCustomEvent: ({ event }) => {
        if (event.name !== CONTENT_PARTS_DROPPED_EVENT) return
        const notice = asDropNotice(event.value)
        if (notice === undefined) return
        setNotices((current) => [...current, notice])
      },
    })
    return () => {
      subscription.unsubscribe()
    }
  }, [agent])

  const dismissRunError = useCallback(() => setRunError(null), [])
  const retryConnect = useCallback(() => {
    setRunError(null)
    setConnectNonce((n) => n + 1)
  }, [])

  // Every hook above has run unconditionally on every render — this return
  // has to come after all of them (rules of hooks). Keyed on `"down"` alone:
  // `"checking"` is the normal shape of a first paint, and showing "cannot
  // connect" for that beat would be a lie for the common case.
  //
  // The sidenav disappears with the chat: nothing in the shell works
  // without a server, including thread switching. `ConnectScreen` carries its
  // own wordmark so the app still has an identity on screen.
  if (serverStatus === "down") {
    return <ConnectScreen serverUrl={DEFAULT_SERVER_URL} onRetry={runProbe} />
  }

  const banner =
    runError === null ? null : (
      <RunError
        title={runError.title}
        message={runError.message}
        onDismiss={dismissRunError}
        onRetry={runError.retryable ? retryConnect : undefined}
      />
    )

  return (
    <B4Activity
      key={`${activeThreadId}:${connectNonce}`}
      labels={NAVLOG_STEP_LABELS}
      renderStep={NAVLOG_STEP_RENDERERS}
    >
      <ThreadWorkbench
        threadId={activeThreadId}
        canAttachImages={canAttachImages}
        header={activeThread?.title ?? UNTITLED_THREAD_LABEL}
        banner={banner}
        notices={<DropNotices notices={notices} />}
        rail={
          <ThreadRail
            threads={threads}
            activeThreadId={activeThreadId}
            onSelect={onSelectThread}
            onCreate={onCreateThread}
            showCreate={false}
          />
        }
        /*
          Not rendered while the server is KNOWN to be down — this return is
          already past the `serverStatus === "down"` branch. It does render
          during "checking", which is why the panel still has a 502 branch of
          its own (a silent one: see its `load`).

          Deliberately NOT thread-scoped: memory candidates are the agent's,
          not a conversation's, and the endpoint has no thread parameter. It
          remounts with the workbench on a switch and re-reads the same queue.
        */
        memory={(controls) => <MemoryPanel onCountChange={setMemoryCount} {...controls} />}
        memoryCount={memoryCount}
        onNewConversation={onCreateThread}
      />
    </B4Activity>
  )
}

interface ThreadWorkbenchProps {
  readonly threadId: string | undefined
  readonly canAttachImages: boolean
  readonly header: string
  readonly banner: ReactNode
  readonly notices: ReactNode
  readonly rail: ReactNode
  readonly memory: (controls: MemoryControls) => ReactNode
  readonly memoryCount: number
  readonly onNewConversation: () => void
}

/**
 * The workbench for one thread, inside `B4Activity`: the map, the weather
 * strip and the navlog sheet read the thread's turns through pure selectors,
 * and the dock holds `NavlogChat`.
 *
 * The selectors return STRINGS and the parse is memoized on them. The turns
 * are rebuilt on every streamed event; parsing afresh each time would give the
 * map a new `Navlog` object per token, and the map refits whenever its
 * geometry changes. A tool result's text never changes once it has arrived, so
 * keying on it gives one object per computation.
 */
function ThreadWorkbench({
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
  const navlogRef = latestNavlogResult(turns)
  const navlogText = navlogRef?.result
  const navlog = useMemo(
    () => (navlogText === undefined ? null : parseNavlog(navlogText)),
    [navlogText],
  )
  const weatherText = latestWeatherBriefText(turns)
  const brief = useMemo(
    () => (weatherText === null ? null : parseWeatherBrief(weatherText)),
    [weatherText],
  )
  // The answer of the turn that produced the navlog on screen, not whatever
  // the latest reply is (a later "Filed." must not replace the brief).
  const assistantBrief =
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

  return (
    <WorkbenchLayout
      navlog={navlog}
      brief={brief}
      assistantBrief={assistantBrief}
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
