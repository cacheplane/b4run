"use client"
import { B4Activity, useB4ChatSlots } from "@b4run/ag-ui/react/copilotkit"
import { CopilotKit, CopilotSidebar } from "@copilotkit/react-core/v2"
import { useEffect, useState } from "react"
import { DemoSuggestions } from "./components/DemoSuggestions"

// Notes (verified against installed @copilotkit/react-core@1.76.0 types):
// - Use the `CopilotKit` wrapper (not bare `CopilotKitProvider`) per CopilotKit's own v2
//   guidance: it adds the error boundary, toasts, and threads provider around the context.
// - The compatibility wrapper still defaults `useSingleEndpoint` to true. V2 transport
//   requires false so `/info` reaches the catch-all `api/copilotkit/[...path]/route.ts`.
// - `CopilotSidebar` ships from `@copilotkit/react-core/v2` and takes the same
//   `messageView` slots as `CopilotChat`, so `useB4ChatSlots` skins it unchanged.
// - The runtime route registers the B4.run /chat agent under CopilotKit's default id.
// - `B4Activity` renders what the agent did: one `TurnActivity` per turn (its tool calls,
//   the `writeTodos` plan, reasoning, any subagent's nested steps) in place of
//   CopilotKit's generic tool rows, and one `ApprovalCard` per parked permission prompt.
//   It owns CopilotKit's single interrupt slot, so the app registers no `useInterrupt`.

const THREAD_KEY = "b4-chat-thread"

/**
 * This tab's thread id, kept in `sessionStorage` so a reload reconnects to the same
 * thread and the runtime route's B4 runner restores it from the server. Read after
 * mount (the server render has no storage); `undefined` until then.
 */
function useTabThreadId(): string | undefined {
  const [threadId, setThreadId] = useState<string | undefined>(undefined)
  useEffect(() => {
    let id: string | null = null
    try {
      id = sessionStorage.getItem(THREAD_KEY)
      if (id === null) {
        id = crypto.randomUUID()
        sessionStorage.setItem(THREAD_KEY, id)
      }
    } catch {
      id = crypto.randomUUID()
    }
    setThreadId(id)
  }, [])
  return threadId
}

function Sidebar({ threadId }: { readonly threadId: string }) {
  const { messageView } = useB4ChatSlots()
  return (
    <CopilotSidebar
      defaultOpen
      threadId={threadId}
      messageView={messageView}
      labels={{ modalHeaderTitle: "B4.run chat" }}
    />
  )
}

export default function Home() {
  const threadId = useTabThreadId()
  return (
    <CopilotKit runtimeUrl="/api/copilotkit" useSingleEndpoint={false} defaultThrottleMs={100}>
      <DemoSuggestions />
      <B4Activity>
        <main style={{ height: "100vh" }}>
          {threadId === undefined ? null : <Sidebar threadId={threadId} />}
        </main>
      </B4Activity>
    </CopilotKit>
  )
}
