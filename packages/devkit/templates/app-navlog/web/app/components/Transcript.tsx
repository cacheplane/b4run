"use client"
import {
  type SubagentEventSource,
  SubagentPanel,
  type SubagentRun,
  useSubagentRuns,
} from "@b4run/ag-ui/react"
import { type B4StepEventValue, readStepEvent } from "@b4run/ag-ui/view"
import {
  CopilotChatAssistantMessage,
  useRenderActivityMessage,
  useRenderToolCall,
} from "@copilotkit/react-core/v2"
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { nextFollowing, showJumpToLatest } from "../lib/stick-to-bottom"
import type { ThreadSource } from "../lib/thread-source"
import {
  buildTranscriptItems,
  type DropNotice,
  type DroppedPartLike,
  type TranscriptItem,
  type TranscriptMessage,
  toolResultText,
} from "../lib/transcript"
import { EmptyState } from "./EmptyState"
import { HydratedInterrupts } from "./HydratedInterrupts"
import { MediaParts } from "./MediaParts"
import { PermissionInterrupt } from "./PermissionInterrupt"
import { RunError } from "./RunError"
import { ToolStepsContext } from "./ToolCallCard"

/**
 * What a restore cannot bring back, said in the app rather than only in the
 * README — quietly. The subagent panel is built from a live event stream the
 * server does not persist (the checkpoint holds messages, tool results and the
 * plan, and nothing else), so the helper activity the user watched is gone for
 * good; new runs show theirs as it happens. Exported so the tests assert the
 * string the user reads.
 */
export const RESTORED_HISTORY_NOTICE =
  "Restored conversation · helper details from earlier runs aren't kept"

/**
 * The line a `notice` item reads: how many parts the model never saw, and for
 * each its type and the reason the adapter gave (`DropReason` in
 * `packages/langchain/src/content-parts.ts`), verbatim — the reason codes are
 * what a developer greps for, and paraphrasing them would hide which one fired.
 */
export function dropNoticeText(parts: readonly DroppedPartLike[]): string {
  const count = parts.length
  const noun = count === 1 ? "content part was" : "content parts were"
  const list = parts.map((part) => `${part.type} (${part.reason})`).join(", ")
  return `${count} ${noun} not sent to the model: ${list}`
}

/**
 * The subagent runs a `task` tool call dispatched, as the sub-map
 * `SubagentPanel` renders: each root run whose `parentToolCallId` is that call,
 * plus every run nested under it (the panel walks `children` through the map it
 * is given). Exported for the tests.
 */
export function runsForToolCall(
  runs: ReadonlyMap<string, SubagentRun>,
  toolCallId: string,
): ReadonlyMap<string, SubagentRun> {
  const out = new Map<string, SubagentRun>()
  const visit = (run: SubagentRun) => {
    if (out.has(run.subagentRunId)) return
    out.set(run.subagentRunId, run)
    for (const childId of run.children) {
      const child = runs.get(childId)
      if (child !== undefined) visit(child)
    }
  }
  for (const run of runs.values()) {
    const isRoot = run.parentSubagentRunId === undefined || !runs.has(run.parentSubagentRunId)
    if (isRoot && run.parentToolCallId === toolCallId) visit(run)
  }
  return out
}

/**
 * The `b4.step` events the live stream carries for this thread's tool calls,
 * by `toolCallId`. They are the server's word on whether a call failed or was
 * denied, which the result text alone cannot always say. Not persisted, so a
 * restored thread starts empty; cleared on a thread switch.
 */
function useToolSteps(
  agent: SubagentEventSource | undefined,
  threadKey: string | undefined,
): ReadonlyMap<string, B4StepEventValue> {
  const [steps, setSteps] = useState<ReadonlyMap<string, B4StepEventValue>>(() => new Map())
  // biome-ignore lint/correctness/useExhaustiveDependencies: threadKey is the reset signal
  useEffect(() => {
    setSteps(new Map())
  }, [threadKey])
  useEffect(() => {
    if (agent === undefined) return
    const subscription = agent.subscribe({
      onCustomEvent: ({ event }) => {
        const step = readStepEvent(event)
        if (step === undefined) return
        setSteps((previous) => {
          const current = previous.get(step.toolCallId)
          if (current?.status === step.status && current.label === step.label) return previous
          const next = new Map(previous)
          next.set(step.toolCallId, { ...current, ...step })
          return next
        })
      },
    })
    return () => subscription.unsubscribe()
  }, [agent])
  return steps
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

export interface TranscriptProps {
  /**
   * The agent whose event stream the subagent panel follows — the instance
   * `useAgent()` hands `AppShell`. Subagents are not messages: they arrive as
   * AG-UI `SUBAGENT_*` events plus events tagged `subagentRunId`, which
   * `useSubagentRuns` reduces into the tree `SubagentPanel` renders.
   */
  readonly agent: SubagentEventSource | undefined
  /**
   * The active thread's id. Two consumers, both about permission gates:
   * `PermissionInterrupt`'s `key`, and `HydratedInterrupts`' fetch.
   *
   * `useInterrupt` keeps its OWN pending state: it is fed by
   * `onRunFinishedEvent` and cleared only by a *new* run, a failure, or
   * unmount — and its subscription effect is keyed `[agent]`, whose identity
   * does not change on a thread switch. Without a remount, thread A's
   * approve/deny card survives a switch to thread B and answers A's
   * interruptId against an agent now pointed at B's thread. Remounting happens
   * at switch time, long before any run, so it does not reintroduce the mount
   * race described below.
   */
  readonly threadKey: string | undefined
  readonly messages: readonly TranscriptMessage[]
  /**
   * The `b4.content_parts_dropped` events `AppShell` collected for this
   * thread, in arrival order. Each becomes a muted line after the tool call
   * or user turn it is about.
   */
  readonly notices?: readonly DropNotice[]
  readonly isRunning: boolean
  readonly onSelectSuggestion: (message: string) => void
  /**
   * Whether these messages came back from the server's checkpoint rather than
   * from a live run — the condition for the note about what a restore cannot
   * bring back.
   */
  readonly hasRestoredHistory: boolean
  /** The last run failure, or null. Owned by `AppShell`. */
  readonly runError: { readonly title: string; readonly message: string } | null
  readonly onDismissRunError: () => void
  readonly onRunError: (error: unknown) => void
  /** Passed straight to `HydratedInterrupts` — the seam it reads parked gates from. */
  readonly threadSource: ThreadSource | null
  /**
   * How many parked gates the hydrated source is showing. Reported up because
   * `AppShell` blocks the composer on it: `agent.pendingInterrupts` is empty
   * after a reload, so it cannot see them.
   */
  readonly onHydratedPendingChange: (count: number) => void
}

const SUBAGENT_CLASS_NAMES = { root: "tracking-tight", title: "font-medium", meta: "tabular-nums" }

/**
 * The message list.
 *
 * The two `use*` hooks here are the manual half of what `<CopilotChat>` does
 * internally, and both are required now that this app renders its own
 * transcript:
 *
 * - `useRenderActivityMessage()` resolves an activity message against the
 *   renderers registered on the provider (`renderActivityMessages`), validating
 *   `content` with the renderer's schema. It is exported from
 *   `@copilotkit/react-core/v2` but NOT from `.../v2/headless`.
 * - `useRenderToolCall()` returns a render function for a
 *   `{ toolCall, toolMessage }` pair, resolved against the renderers registered
 *   by `useRenderTool` — that is `ToolCallCard`. Note the near-namesake:
 *   `useRenderTool` registers, `useRenderToolCall` renders.
 *
 * SUBAGENTS RENDER WHERE THEY RAN. Each subagent card sits directly under the
 * `task` call that dispatched it (matched by `parentToolCallId`), not in one
 * panel after the whole list — at the end, every finished subagent of the
 * thread trailed the newest message, so "weather · completed" reappeared below
 * every later answer. A run whose dispatching call is not in the list (it has
 * not streamed in yet) still renders, at the end, until its call arrives.
 *
 * STICK TO BOTTOM. While the reader is at the bottom, new output keeps them
 * there; scrolling up stops that and offers "Jump to latest". The rules are
 * `app/lib/stick-to-bottom.ts`.
 *
 * `PermissionInterrupt` is rendered at the end of the list, after the messages,
 * because that is where the run actually stopped. It is a `renderInChat: false`
 * interrupt, so it appears exactly where it is placed and nowhere else.
 *
 * It is mounted UNCONDITIONALLY — outside the empty/non-empty branch — and that
 * is a correctness requirement, not tidiness. `useInterrupt` subscribes to the
 * agent from a mount effect, so branching on `items.length` would make the
 * subscription's existence depend on render timing, and a thread hydrated
 * already parked would render its gate nowhere, silently. The wrapper is
 * `empty:hidden` so it costs no layout when neither the gate nor an error is
 * showing.
 */
export function Transcript({
  agent,
  threadKey,
  messages,
  notices = [],
  isRunning,
  onSelectSuggestion,
  hasRestoredHistory,
  runError,
  onDismissRunError,
  onRunError,
  threadSource,
  onHydratedPendingChange,
}: TranscriptProps) {
  const { renderActivityMessage } = useRenderActivityMessage()
  const renderToolCall = useRenderToolCall()
  const subagents = useSubagentRuns(agent)
  const steps = useToolSteps(agent, threadKey)
  // NOT memoized on `messages`, and that is load-bearing. `AbstractAgent`
  // mutates its `messages` array in place (`addMessage` does `push`), so the
  // reference is stable across a run and `useMemo(..., [messages])` would keep
  // serving the list from before the push. Rebuilding every render is cheap,
  // and the provider's `defaultThrottleMs` already caps how often it happens.
  const items = buildTranscriptItems(messages, notices)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const followingRef = useRef(true)
  const lastTopRef = useRef(0)
  const [jumpVisible, setJumpVisible] = useState(false)

  const scrollToBottom = useCallback((smooth: boolean) => {
    const node = scrollRef.current
    if (node === null) return
    const top = node.scrollHeight
    if (smooth && typeof node.scrollTo === "function") node.scrollTo({ top, behavior: "smooth" })
    else node.scrollTop = top
  }, [])

  // A new thread starts at its newest message, following.
  // biome-ignore lint/correctness/useExhaustiveDependencies: threadKey is the reset signal
  useEffect(() => {
    followingRef.current = true
    setJumpVisible(false)
    scrollToBottom(false)
  }, [threadKey, scrollToBottom])

  // Follow the stream. No dependency array on purpose: a run appends text to an
  // existing message as often as it adds a new one, so "the messages changed"
  // is not a value this component can watch — every render is the signal.
  // Layout effect, so the jump lands before paint and nothing flickers.
  useLayoutEffect(() => {
    if (followingRef.current) scrollToBottom(false)
  })

  // Content can also grow with no render here: an image finishing loading, a
  // package card expanding. Follow those too while following.
  useEffect(() => {
    const content = contentRef.current
    if (content === null || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      if (followingRef.current) scrollToBottom(false)
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [scrollToBottom])

  function onScroll() {
    const node = scrollRef.current
    if (node === null) return
    const metrics = {
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    }
    followingRef.current = nextFollowing(followingRef.current, lastTopRef.current, metrics)
    lastTopRef.current = node.scrollTop
    setJumpVisible(showJumpToLatest(followingRef.current, metrics))
  }

  function jumpToLatest() {
    followingRef.current = true
    setJumpVisible(false)
    scrollToBottom(!prefersReducedMotion())
  }

  const placedRuns = new Set<string>()

  function subagentsFor(toolCallId: string): ReactNode {
    const runs = runsForToolCall(subagents.runs, toolCallId)
    if (runs.size === 0) return null
    for (const id of runs.keys()) placedRuns.add(id)
    return (
      <div className="mt-2 pl-3">
        <SubagentPanel runs={runs} classNames={SUBAGENT_CLASS_NAMES} />
      </div>
    )
  }

  function renderItem(item: TranscriptItem) {
    switch (item.kind) {
      case "user":
        return (
          <div key={item.id} className="flex flex-col items-end gap-2 pl-8">
            {item.text.length > 0 ? (
              <p className="whitespace-pre-wrap break-words rounded-wb rounded-br-sm bg-wb-rail px-3.5 py-2 text-[14px] leading-6 text-wb-text ring-1 ring-wb-border ring-inset">
                {item.text}
              </p>
            ) : null}
            {item.parts !== undefined ? (
              <div className="max-w-full">
                <MediaParts parts={item.parts} />
              </div>
            ) : null}
          </div>
        )
      case "assistant":
        // Markdown, not raw text: `CopilotChatAssistantMessage.MarkdownRenderer`
        // is a pass-through to Streamdown, built for *streaming* markdown. Only
        // the renderer, not `CopilotChatAssistantMessage` itself, which would
        // drag in the copy/thumbs/regenerate toolbar. The look is `.wb-prose`
        // in `app/theme.css`. No bubble: the assistant's answer is the page's
        // prose, the user's turn is the bubble.
        return (
          <div key={item.id} className="wb-prose break-words">
            <CopilotChatAssistantMessage.MarkdownRenderer content={item.text} />
          </div>
        )
      case "reasoning":
        return (
          <p
            key={item.id}
            className="whitespace-pre-wrap break-words border-l-2 border-wb-border pl-3 text-[13px] italic leading-6 text-wb-muted"
          >
            {item.text}
          </p>
        )
      case "activity":
        return (
          <div key={item.id}>
            {renderActivityMessage({
              id: item.id,
              role: "activity",
              activityType: item.activityType,
              content: item.content,
            })}
          </div>
        )
      case "toolCall":
        return (
          <div key={item.id}>
            {renderToolCall({
              toolCall: item.toolCall,
              ...(item.toolResult !== undefined
                ? {
                    toolMessage: {
                      ...item.toolResult,
                      content: toolResultText(item.toolResult.content),
                    },
                  }
                : {}),
            })}
            {/*
              Media goes HERE, beside the card rather than inside it.
              CopilotKit's tool renderer only ever receives
              `contentToText(content)`, so this is the only place a tool
              result's image (or audio, video, document) can be drawn.
            */}
            {item.toolResult?.parts !== undefined ? (
              <div className="mt-2">
                <MediaParts parts={item.toolResult.parts} />
              </div>
            ) : null}
            {item.toolCall.function.name === "task" ? subagentsFor(item.id) : null}
          </div>
        )
      case "notice":
        return (
          <p key={item.id} className="text-[12px] leading-5 text-wb-muted">
            {dropNoticeText(item.parts)}
          </p>
        )
      default: {
        // Exhaustiveness, not a fallback. A new `TranscriptItem` kind must fail
        // to compile here rather than silently render as nothing.
        const unhandled: never = item
        return unhandled
      }
    }
  }

  const rendered = items.map(renderItem)
  // Runs whose dispatching `task` call is not (yet) in the list.
  const unplaced = new Map(
    [...subagents.runs].filter(([id]) => !placedRuns.has(id)),
  ) as ReadonlyMap<string, SubagentRun>

  return (
    <ToolStepsContext.Provider value={steps}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
        >
          <div ref={contentRef} className="flex min-h-full flex-col">
            {items.length === 0 ? <EmptyState onSelectSuggestion={onSelectSuggestion} /> : null}
            {/*
              Rendered OUTSIDE the live region below: it is static context for
              what is already on screen, not an addition worth announcing.
            */}
            {hasRestoredHistory ? (
              <p className="mx-auto flex max-w-3xl items-center gap-2 px-4 pt-4 text-[11.5px] leading-5 text-wb-muted md:px-5">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.25"
                  strokeLinecap="round"
                  aria-hidden="true"
                  className="shrink-0"
                >
                  <path d="M2 6a4 4 0 1 0 1.2-2.85M2 1.75v1.9h1.9" />
                </svg>
                {RESTORED_HISTORY_NOTICE}
              </p>
            ) : null}
            {/*
              The live region is the message list itself, and it is rendered in
              both states so it exists BEFORE its content changes — a region
              inserted at the same moment as its first content is unreliably
              announced. `role="log"` is the right role for an append-only
              transcript, and `aria-relevant="additions text"` covers the answer
              streaming in character by character.
            */}
            <div
              role="log"
              aria-live="polite"
              aria-relevant="additions text"
              className={
                items.length === 0
                  ? "mx-auto max-w-3xl px-4 md:px-5"
                  : `mx-auto flex max-w-3xl flex-col gap-4 px-4 pb-6 md:px-5 ${hasRestoredHistory ? "pt-3" : "pt-5"}`
              }
            >
              {rendered}
              {unplaced.size > 0 ? (
                <SubagentPanel runs={unplaced} classNames={SUBAGENT_CLASS_NAMES} />
              ) : null}
              {/* Persistent, with toggling text — same reason as the region above. */}
              <p className="flex items-center gap-2 text-[13px] text-wb-muted empty:hidden">
                {isRunning ? (
                  <>
                    <span aria-hidden="true" className="flex gap-1">
                      <span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" />
                      <span className="size-1.5 rounded-full bg-current opacity-70 motion-safe:animate-pulse [animation-delay:150ms]" />
                      <span className="size-1.5 rounded-full bg-current opacity-40 motion-safe:animate-pulse [animation-delay:300ms]" />
                    </span>
                    Working…
                  </>
                ) : null}
              </p>
            </div>
            <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 pb-6 empty:hidden md:px-5">
              {/*
                The two sources of permission gates, side by side and
                deliberately both mounted. `PermissionInterrupt` shows the ones
                this browser watched a run park on; `HydratedInterrupts` shows
                the ones the server was already holding when the page loaded.
                They cannot show the same interrupt twice (see each file).

                `HydratedInterrupts` takes the thread id as a PROP rather than
                as its `key`: its own effect keys on that id, so a remount
                would only throw away the answer it is about to fetch again.
              */}
              <PermissionInterrupt key={threadKey} onError={onRunError} isResuming={isRunning} />
              <HydratedInterrupts
                threadId={threadKey}
                threadSource={threadSource}
                onError={onRunError}
                onPendingChange={onHydratedPendingChange}
              />
              {runError !== null ? (
                <RunError
                  title={runError.title}
                  message={runError.message}
                  onDismiss={onDismissRunError}
                />
              ) : null}
            </div>
          </div>
        </div>
        {jumpVisible ? (
          <button
            type="button"
            onClick={jumpToLatest}
            className="wb-focus absolute bottom-3 left-1/2 inline-flex min-h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border border-wb-border bg-wb-surface px-3.5 py-1.5 text-[12.5px] font-medium tracking-tight shadow-lg shadow-black/10 transition-colors hover:border-wb-muted pointer-coarse:min-h-11"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 2v8M2.5 6.5 6 10l3.5-3.5" />
            </svg>
            Jump to latest
          </button>
        ) : null}
      </div>
    </ToolStepsContext.Provider>
  )
}
