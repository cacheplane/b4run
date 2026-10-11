"use client"
import { B4Activity } from "@b4run/ag-ui/react/copilotkit"
import { useAgent, useCapabilities } from "@copilotkit/react-core/v2"
import { useState } from "react"
import type { WorkbenchThread } from "../lib/thread-source"
import { useDropNotices } from "../lib/use-drop-notices"
import { useRunErrors } from "../lib/use-run-errors"
import { useServerStatus } from "../lib/use-server-status"
import { useThreadSwitchReset } from "../lib/use-thread-switch"
import { useThreadTitles } from "../lib/use-thread-titles"
import { ConnectScreen } from "./ConnectScreen"
import { DropNotices } from "./DropNotices"
import { MemoryPanel } from "./MemoryPanel"
import { RunError } from "./RunError"
import { NAVLOG_STEP_LABELS, NAVLOG_STEP_RENDERERS } from "./StepViews"
import { ThreadRail, UNTITLED_THREAD_LABEL } from "./ThreadRail"
import { ThreadWorkbench } from "./ThreadWorkbench"

/**
 * THE ERROR-SURFACE NOTE. Three surfaces can report a failure in this app, and
 * they are stated once here so the sites that implement them can cite this
 * instead of each re-arguing why they are not the others.
 *
 * 1. `ConnectScreen` — the server is KNOWN to be down: a probe through the
 *    proxy came back 502 (`probeB4Server` in `lib/use-server-status.ts`). It
 *    replaces the entire shell, because nothing in the shell works without a
 *    server.
 * 2. The `RunError` banner in the chat dock — something failed while the shell
 *    is UP and there is a conversation on screen to attach it to: a run, a
 *    resume, or loading the conversation (`RUN_ERROR_TITLES`, via the
 *    `copilotkit.subscribe` seam in `lib/use-run-errors.ts`). A failed load
 *    offers Retry.
 * 3. The memory panel's quiet muted line — its own candidate read
 *    (`lib/use-memory-candidates.ts`) failing for a reason that is NOT a 502.
 *    A 502 there is surface 1's fact, so the panel stays silent for it rather
 *    than competing.
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
 * titling, and the keyed `B4Activity` the workbench (`ThreadWorkbench`)
 * lives in. Each of those is a hook in `lib/`; this component composes them,
 * swaps in the connect screen while the server is down, and renders.
 *
 * `useAgent()` is deliberately called with NO arguments. Its props have exactly
 * two legal shapes: unscoped (`useAgent()` / `useAgent({ agentId })`), which
 * takes its thread from the surrounding chat configuration, or thread-scoped
 * (`{ agentId, runtimeAgentId, threadId }` — all three, or it throws at
 * runtime), which registers a *private proxied* agent. The unscoped form is
 * what this app wants: `CopilotChat`, `B4Activity`'s `useInterrupt` and
 * `useSuggestions` all resolve their agent the same way, so one
 * `CopilotChatConfigurationProvider` (mounted in `page.tsx`) keeps every hook
 * bound to the same agent and the same thread. The hooks below take this one
 * agent as an argument rather than each resolving it again.
 *
 * `B4Activity` is keyed by the thread, because `useInterrupt` clears its
 * pending card only on a new run: an activity that outlived a switch would
 * show the previous thread's approval card on the next one. The key also
 * restarts the turns from empty, and the remount remounts `CopilotChat`, which
 * connects the new thread — the runtime route replays it from B4.run's
 * storage. `connectNonce` is in the key so Retry on a failed load connects
 * again.
 */
export function AppShell({
  threads,
  activeThreadId,
  onSelectThread,
  onCreateThread,
  onUserMessage,
}: AppShellProps) {
  const { agent } = useAgent()
  // The route's capability document, as CopilotKit's runtime `/info` sync
  // fetched it from `B4HttpAgent.getCapabilities()` — in the browser the agent
  // is the runtime's proxy, so this hook (not a direct `getCapabilities()`
  // call) is how the page reads it. `undefined` until the handshake lands,
  // which correctly hides the attach control until then.
  const capabilities = useCapabilities()
  const canAttachImages = capabilities?.multimodal?.input?.image === true
  // Memory candidates waiting, reported by `MemoryPanel`, for the sidenav's count.
  const [memoryCount, setMemoryCount] = useState(0)
  const activeThread = threads.find((thread) => thread.id === activeThreadId)

  const server = useServerStatus()
  const runErrors = useRunErrors(server.status)
  const dropNotices = useDropNotices(agent)
  // The order of the next two calls is load-bearing: effects run in call
  // order, and the titling effect must see the messages the switch reset
  // has already cleared (see `useThreadSwitchReset`).
  useThreadSwitchReset(agent, activeThreadId, () => {
    runErrors.clear()
    dropNotices.clear()
  })
  useThreadTitles({ agent, activeThreadId, activeThread, onUserMessage })

  // Every hook above has run unconditionally on every render — this return
  // has to come after all of them (rules of hooks). Keyed on `"down"` alone:
  // `"checking"` is the normal shape of a first paint, and showing "cannot
  // connect" for that beat would be a lie for the common case.
  //
  // The sidenav disappears with the chat: nothing in the shell works
  // without a server, including thread switching. `ConnectScreen` carries its
  // own wordmark so the app still has an identity on screen.
  if (server.status === "down") {
    return <ConnectScreen serverUrl={DEFAULT_SERVER_URL} onRetry={server.retry} />
  }

  const { runError } = runErrors
  const banner =
    runError === null ? null : (
      <RunError
        title={runError.title}
        message={runError.message}
        onDismiss={runErrors.clear}
        onRetry={runError.retryable ? runErrors.retry : undefined}
      />
    )

  return (
    <B4Activity
      key={`${activeThreadId}:${runErrors.connectNonce}`}
      labels={NAVLOG_STEP_LABELS}
      renderStep={NAVLOG_STEP_RENDERERS}
    >
      <ThreadWorkbench
        threadId={activeThreadId}
        canAttachImages={canAttachImages}
        header={activeThread?.title ?? UNTITLED_THREAD_LABEL}
        banner={banner}
        notices={<DropNotices notices={dropNotices.notices} />}
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
          already past the `server.status === "down"` branch. It does render
          during "checking", which is why the panel still has a 502 branch of
          its own (a silent one: see `load` in `useMemoryCandidates`).

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
