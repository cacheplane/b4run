"use client"
import { CopilotChatConfigurationProvider, CopilotKit } from "@copilotkit/react-core/v2"
import { useCallback, useEffect, useState } from "react"
import { AppShell } from "./components/AppShell"
import { DemoSuggestions } from "./components/DemoSuggestions"
import {
  createLocalThreadSource,
  type ThreadSource,
  type WorkbenchThread,
} from "./lib/thread-source"

// Notes (verified against installed @copilotkit/react-core@1.70.0 types — see
// examples/chat/web/app/page.tsx for the original investigation):
// - Use the `CopilotKit` wrapper (not bare `CopilotKitProvider`) per CopilotKit's own v2
//   guidance: it adds the error boundary, toasts, and threads provider around the context.
//   Its props are a superset of CopilotKitProviderProps (so `runtimeUrl` applies).
// - The compatibility wrapper still defaults `useSingleEndpoint` to true. V2 transport
//   requires false so `/info` reaches the catch-all `api/copilotkit/[...path]/route.ts`.
// - `CopilotChat`/`CopilotSidebar` ship from `@copilotkit/react-core/v2`, not
//   `@copilotkit/react-ui` (react-ui's root export is the v1 components, incompatible with
//   the v2 context; react-ui exposes no `/v2` JS export, only `/v2/styles.css`). The dock's
//   chat is the v2 `CopilotChat` inside B4.run's `B4Activity` (`NavlogChat`).
// - Components/hooks that omit agentId resolve CopilotKit's default id ("default").
//   The catch-all route (api/copilotkit/[...path]/route.ts) registers the B4.run /navlog route
//   under "default", so every hook binds without per-component agentId wiring.
// - `defaultThrottleMs` coalesces the useAgent re-renders that the chat and panels
//   get from OnMessagesChanged/OnStateChanged. It defaults to UNTHROTTLED,
//   and a full planning run streams hundreds of events, which pegs the renderer
//   (the UI freezes). 100ms keeps it live-feeling while capping re-renders.
//
// Why `CopilotChatConfigurationProvider` is mounted here: `CopilotKit` does not
// provide one, and `<CopilotChat>` provides one only for its own subtree. The shell's
// `useAgent()`, `B4Activity` and `DemoSuggestions` sit OUTSIDE the chat, and without
// this provider they would fall back to the default agent's own auto-minted thread.
// With `threadId` set, the provider is thread-controlled and `useAgent()` writes that
// id onto the agent (it only does so when the configuration reports
// `hasExplicitThreadId`, which a `threadId` prop implies).
//
// No `renderActivityMessages`: B4.run's plan is a step in the turn's activity
// (`B4Activity`'s `PlanStep`), not a separate activity card.
export default function Home() {
  // `createLocalThreadSource` touches localStorage, which does not exist during
  // SSR — hence the guard. It stays null on the server; the effect below runs
  // only in the browser, so the server and the first client render agree
  // (no threads, no active id).
  const [source] = useState<ThreadSource | null>(() =>
    typeof window === "undefined" ? null : createLocalThreadSource(window.localStorage),
  )
  const [threads, setThreads] = useState<readonly WorkbenchThread[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (source === null) return
    const existing = source.list()
    // Most-recent-first, so resuming means resuming the last conversation.
    const active = existing[0] ?? source.create()
    setThreads(source.list())
    setActiveThreadId(active.id)
  }, [source])

  const handleCreate = useCallback(() => {
    if (source === null) return
    // A second "New conversation" click must not add a second identical
    // untitled row. A thread stays untitled until its first user message
    // lands, so "the active thread has no title" is exactly "it is already the
    // blank conversation you are asking for": the click is a no-op.
    const active = threads.find((thread) => thread.id === activeThreadId)
    if (active !== undefined && active.title === undefined) return
    const created = source.create()
    setThreads(source.list())
    setActiveThreadId(created.id)
  }, [source, threads, activeThreadId])

  const handleSelect = useCallback((threadId: string) => {
    setActiveThreadId(threadId)
  }, [])

  const handleUserMessage = useCallback(
    (message: string) => {
      if (source === null || activeThreadId === undefined) return
      source.touch(activeThreadId, message)
      setThreads(source.list())
    },
    [source, activeThreadId],
  )

  return (
    <CopilotKit
      runtimeUrl="/api/copilotkit"
      useSingleEndpoint={false}
      defaultThrottleMs={100}
      // Off deliberately. `enableInspector` defaults to CopilotKit's own
      // `isLocalhost()` check -- NOT to NODE_ENV -- so leaving it unset mounts a
      // vendor-branded panel over the workbench on the documented `npm run
      // dev:web`, and fetches an announcement banner from cdn.copilotkit.ai.
      // This is the first screen of a freshly scaffolded app; it should be the
      // agent, not an ad. Set it to `true` if you want CopilotKit's inspector.
      enableInspector={false}
    >
      <CopilotChatConfigurationProvider threadId={activeThreadId}>
        {/* Registration-only: publishes the starter prompts into CopilotKit's
            suggestion registry, which `CopilotChat` shows as pills on an empty
            thread. */}
        <DemoSuggestions />
        <AppShell
          threads={threads}
          activeThreadId={activeThreadId}
          onSelectThread={handleSelect}
          onCreateThread={handleCreate}
          onUserMessage={handleUserMessage}
        />
      </CopilotChatConfigurationProvider>
    </CopilotKit>
  )
}
