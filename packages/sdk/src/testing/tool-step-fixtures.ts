import type { B4AnswerAnnotations, B4ToolStep } from "../tool-step.js"
import type { ToolStepFixtureEvent } from "./fold-tool-step-events.js"

/**
 * One contract fixture: an AG-UI event stream paired with the per-call step
 * view (and answer annotations) a conforming consumer must end with.
 */
export interface ToolStepFixture {
  readonly name: string
  readonly events: readonly ToolStepFixtureEvent[]
  readonly expected: {
    readonly steps: Readonly<Record<string, B4ToolStep>>
    readonly answers?: Readonly<Record<string, B4AnswerAnnotations>>
  }
}

const STEP = "b4.step"
const ANSWER = "b4.answer"
const DEFAULT_ERROR = { message: "Tool call did not finish" }

const start = (toolCallId: string, step?: unknown): ToolStepFixtureEvent => ({
  type: "TOOL_CALL_START",
  toolCallId,
  toolCallName: "lookup",
  ...(step !== undefined ? { metadata: { [STEP]: step } } : {}),
})
const end = (toolCallId: string, step?: unknown): ToolStepFixtureEvent => ({
  type: "TOOL_CALL_END",
  toolCallId,
  ...(step !== undefined ? { metadata: { [STEP]: step } } : {}),
})
const result = (toolCallId: string, step?: unknown): ToolStepFixtureEvent => ({
  type: "TOOL_CALL_RESULT",
  toolCallId,
  messageId: `result-${toolCallId}`,
  content: "ok",
  ...(step !== undefined ? { metadata: { [STEP]: step } } : {}),
})
const custom = (value: unknown): ToolStepFixtureEvent => ({ type: "CUSTOM", name: STEP, value })

/**
 * The tool-step contract's fixture corpus. Run `foldToolStepEvents` (or your
 * own reducer) over each fixture's events and expect its `expected` view.
 */
export const TOOL_STEP_FIXTURES: readonly ToolStepFixture[] = [
  {
    name: "metadata-lifecycle",
    events: [
      start("c1", {
        v: 1,
        kind: "server",
        status: "running",
        label: "Searching flights",
        startedAt: 1000,
      }),
      end("c1", {
        v: 1,
        kind: "server",
        status: "running",
        label: "Searching flights",
        startedAt: 1000,
      }),
      result("c1", {
        v: 1,
        kind: "server",
        status: "completed",
        label: "Searched flights",
        settledAt: 2000,
      }),
    ],
    expected: {
      steps: {
        c1: {
          v: 1,
          kind: "server",
          status: "completed",
          label: "Searched flights",
          startedAt: 1000,
          settledAt: 2000,
        },
      },
    },
  },
  {
    name: "custom-only-lifecycle",
    events: [
      start("c1"),
      custom({
        v: 1,
        toolCallId: "c1",
        kind: "server",
        status: "running",
        label: "Checking inventory",
        startedAt: 1500,
      }),
      end("c1"),
      custom({
        v: 1,
        toolCallId: "c1",
        kind: "server",
        status: "completed",
        label: "Checked inventory",
        settledAt: 2500,
      }),
      result("c1"),
    ],
    expected: {
      steps: {
        c1: {
          v: 1,
          kind: "server",
          status: "completed",
          label: "Checked inventory",
          startedAt: 1500,
          settledAt: 2500,
        },
      },
    },
  },
  {
    name: "legacy-custom-step",
    events: [
      start("c1"),
      end("c1"),
      custom({
        toolCallId: "c1",
        status: "completed",
        label: "Looked up order",
        sources: [
          { title: "Order 42", href: "https://example.com/orders/42" },
          { title: "Customer record" },
        ],
        startedAt: "2026-10-21T10:00:00.000Z",
        settledAt: "2026-10-21T10:00:02.000Z",
      }),
      result("c1"),
    ],
    expected: {
      steps: {
        c1: {
          v: 1,
          kind: "server",
          status: "completed",
          label: "Looked up order",
          sources: [
            { id: "c1:0", kind: "url", title: "Order 42", href: "https://example.com/orders/42" },
            { id: "c1:1", kind: "record", title: "Customer record" },
          ],
          startedAt: 1792576800000,
          settledAt: 1792576802000,
        },
      },
    },
  },
  {
    name: "step-before-start",
    events: [
      custom({
        v: 1,
        toolCallId: "c1",
        kind: "server",
        status: "running",
        label: "Fetching report",
        startedAt: 3000,
      }),
      start("c1"),
      end("c1"),
      custom({
        v: 1,
        toolCallId: "c1",
        kind: "server",
        status: "completed",
        label: "Fetched report",
        settledAt: 4000,
      }),
      result("c1"),
    ],
    expected: {
      steps: {
        c1: {
          v: 1,
          kind: "server",
          status: "completed",
          label: "Fetched report",
          startedAt: 3000,
          settledAt: 4000,
        },
      },
    },
  },
  {
    name: "failed-step-beats-later-result",
    events: [
      start("c1", {
        v: 1,
        kind: "server",
        status: "running",
        label: "Calling billing",
        startedAt: 5000,
      }),
      end("c1"),
      custom({
        v: 1,
        toolCallId: "c1",
        kind: "server",
        status: "failed",
        settledAt: 5500,
        error: { message: "Upstream returned 500", code: "UPSTREAM" },
      }),
      result("c1", {
        v: 1,
        kind: "server",
        status: "completed",
        label: "Called billing",
        settledAt: 6000,
      }),
    ],
    expected: {
      steps: {
        c1: {
          v: 1,
          kind: "server",
          status: "failed",
          startedAt: 5000,
          settledAt: 5500,
          error: { message: "Upstream returned 500", code: "UPSTREAM" },
        },
      },
    },
  },
  {
    name: "denied-clears-label",
    events: [
      start("c1", {
        v: 1,
        kind: "server",
        status: "running",
        label: "Deleting account",
        icon: "shield",
        sources: [{ id: "c1:0", kind: "record", title: "Account 7" }],
        startedAt: 7000,
      }),
      end("c1"),
      custom({
        v: 1,
        toolCallId: "c1",
        kind: "server",
        status: "denied",
        decision: "deny",
        settledAt: 7400,
      }),
      result("c1"),
    ],
    expected: {
      steps: {
        c1: {
          v: 1,
          kind: "server",
          status: "denied",
          icon: "shield",
          decision: "deny",
          startedAt: 7000,
          settledAt: 7400,
        },
      },
    },
  },
  {
    name: "message-step-beats-call-step",
    events: [
      start("c1", {
        v: 1,
        kind: "server",
        status: "completed",
        label: "From the call",
        queries: ["call"],
        settledAt: 8000,
      }),
      end("c1"),
      result("c1", {
        v: 1,
        kind: "server",
        status: "completed",
        label: "From the message",
        queries: ["message"],
        settledAt: 8100,
      }),
    ],
    expected: {
      steps: {
        c1: {
          v: 1,
          kind: "server",
          status: "completed",
          label: "From the message",
          queries: ["message"],
          settledAt: 8100,
        },
      },
    },
  },
  {
    name: "run-error-settles-open",
    events: [
      { type: "RUN_STARTED" },
      start("c1", {
        v: 1,
        kind: "server",
        status: "completed",
        label: "Done early",
        settledAt: 8800,
      }),
      end("c1"),
      result("c1"),
      start("c2", {
        v: 1,
        kind: "server",
        status: "running",
        label: "Slow query",
        sources: [{ id: "c2:0", kind: "record", title: "Ledger" }],
        startedAt: 8900,
      }),
      end("c2"),
      start("c3"),
      { type: "RUN_ERROR", timestamp: 9000 },
    ],
    expected: {
      steps: {
        c1: { v: 1, kind: "server", status: "completed", label: "Done early", settledAt: 8800 },
        c2: {
          v: 1,
          kind: "server",
          status: "failed",
          startedAt: 8900,
          settledAt: 9000,
          error: DEFAULT_ERROR,
        },
        c3: { v: 1, kind: "server", status: "failed", settledAt: 9000, error: DEFAULT_ERROR },
      },
    },
  },
  {
    name: "cancelled-run-settles-open",
    events: [
      { type: "RUN_STARTED" },
      start("c1", {
        v: 1,
        kind: "server",
        status: "running",
        label: "Exporting data",
        startedAt: 9100,
      }),
      end("c1"),
      start("c2", {
        v: 1,
        kind: "server",
        status: "completed",
        label: "Counted rows",
        settledAt: 9200,
      }),
      end("c2"),
      result("c2"),
      { type: "RUN_FINISHED", outcome: { type: "cancelled" }, timestamp: 9500 },
    ],
    expected: {
      steps: {
        c1: { v: 1, kind: "server", status: "cancelled", startedAt: 9100, settledAt: 9500 },
        c2: { v: 1, kind: "server", status: "completed", label: "Counted rows", settledAt: 9200 },
      },
    },
  },
  {
    name: "interrupt-keeps-pending-open",
    events: [
      { type: "RUN_STARTED" },
      start("c1", {
        v: 1,
        kind: "server",
        status: "running",
        label: "Waiting for approval",
        startedAt: 9600,
      }),
      end("c1"),
      start("c2", {
        v: 1,
        kind: "server",
        status: "running",
        label: "Orphaned call",
        startedAt: 9650,
      }),
      end("c2"),
      {
        type: "RUN_FINISHED",
        outcome: {
          type: "interrupt",
          interrupts: [{ id: "i1", reason: "tool_approval", toolCallId: "c1" }],
        },
        timestamp: 9700,
      },
    ],
    expected: {
      steps: {
        c1: {
          v: 1,
          kind: "server",
          status: "running",
          label: "Waiting for approval",
          startedAt: 9600,
        },
        c2: { v: 1, kind: "server", status: "cancelled", startedAt: 9650, settledAt: 9700 },
      },
    },
  },
  {
    name: "unknown-status-falls-back",
    events: [
      start("c1"),
      custom({
        v: 1,
        toolCallId: "c1",
        kind: "server",
        status: "paused-for-review",
        label: "Reviewing",
      }),
      end("c1"),
      result("c1"),
      start("c2"),
      custom({
        v: 1,
        toolCallId: "c2",
        kind: "server",
        status: "paused-for-review",
        label: "Still reviewing",
      }),
      end("c2"),
    ],
    expected: {
      steps: {
        // The result completed it, so the label it ran under goes.
        c1: { v: 1, kind: "server", status: "completed" },
        c2: { v: 1, kind: "server", status: "running", label: "Still reviewing" },
      },
    },
  },
  {
    name: "provider-web-search-with-citations",
    events: [
      {
        type: "TOOL_CALL_START",
        toolCallId: "ws_1",
        toolCallName: "web_search",
        metadata: {
          [STEP]: {
            v: 1,
            kind: "provider",
            builtin: "web_search",
            provider: "openai",
            status: "running",
            label: "Searching the web",
            startedAt: 10000,
          },
        },
      },
      end("ws_1", {
        v: 1,
        kind: "provider",
        builtin: "web_search",
        provider: "openai",
        status: "running",
        label: "Searching the web",
        queries: ["KSFO weather"],
        startedAt: 10000,
      }),
      result("ws_1", {
        v: 1,
        kind: "provider",
        builtin: "web_search",
        provider: "openai",
        status: "completed",
        label: "Searched the web",
        queries: ["KSFO weather"],
        sources: [
          {
            id: "ws_1:0",
            kind: "url",
            title: "KSFO current conditions",
            href: "https://example.com/ksfo",
            cited: true,
          },
          {
            id: "ws_1:1",
            kind: "url",
            title: "SFO airport status",
            href: "https://example.com/sfo",
            cited: false,
          },
        ],
        settledAt: 11000,
      }),
      { type: "TEXT_MESSAGE_START", messageId: "m1" },
      {
        type: "TEXT_MESSAGE_END",
        messageId: "m1",
        metadata: {
          [ANSWER]: {
            v: 1,
            citations: [
              {
                sourceId: "ws_1:0",
                quote: "KSFO winds are 14 knots from the west now.",
                block: 0,
                start: 0,
                end: 42,
              },
            ],
          },
        },
      },
    ],
    expected: {
      steps: {
        ws_1: {
          v: 1,
          kind: "provider",
          builtin: "web_search",
          provider: "openai",
          status: "completed",
          label: "Searched the web",
          queries: ["KSFO weather"],
          sources: [
            {
              id: "ws_1:0",
              kind: "url",
              title: "KSFO current conditions",
              href: "https://example.com/ksfo",
              cited: true,
            },
            {
              id: "ws_1:1",
              kind: "url",
              title: "SFO airport status",
              href: "https://example.com/sfo",
              cited: false,
            },
          ],
          startedAt: 10000,
          settledAt: 11000,
        },
      },
      answers: {
        m1: {
          v: 1,
          citations: [
            {
              sourceId: "ws_1:0",
              quote: "KSFO winds are 14 knots from the west now.",
              block: 0,
              start: 0,
              end: 42,
            },
          ],
        },
      },
    },
  },
  {
    name: "frames-only-no-step",
    events: [start("c1"), end("c1"), result("c1"), start("c2"), end("c2")],
    expected: {
      steps: {
        c1: { v: 1, kind: "server", status: "completed" },
        c2: { v: 1, kind: "server", status: "running" },
      },
    },
  },
  {
    name: "result-completes-running-step",
    events: [
      start("c1", {
        v: 1,
        kind: "server",
        status: "running",
        label: "Rendering chart",
        sources: [{ id: "c1:0", kind: "record", title: "Sales table" }],
        startedAt: 12000,
      }),
      end("c1"),
      result("c1"),
    ],
    expected: {
      steps: {
        // Completed by the frames: the running label goes, the sources stay.
        c1: {
          v: 1,
          kind: "server",
          status: "completed",
          sources: [{ id: "c1:0", kind: "record", title: "Sales table" }],
          startedAt: 12000,
        },
      },
    },
  },
  {
    name: "success-run-leaves-open-steps",
    events: [
      { type: "RUN_STARTED" },
      start("c1", {
        v: 1,
        kind: "server",
        status: "running",
        label: "Syncing in background",
        startedAt: 13000,
      }),
      end("c1"),
      { type: "RUN_FINISHED", outcome: { type: "success" }, timestamp: 13100 },
    ],
    expected: {
      steps: {
        c1: {
          v: 1,
          kind: "server",
          status: "running",
          label: "Syncing in background",
          startedAt: 13000,
        },
      },
    },
  },
  {
    name: "cancelled-run-ignores-pending-ids",
    events: [
      { type: "RUN_STARTED" },
      start("c1", {
        v: 1,
        kind: "server",
        status: "running",
        label: "Uploading",
        startedAt: 13500,
      }),
      end("c1"),
      start("c2", { v: 1, kind: "server", status: "running", label: "Indexing", startedAt: 13600 }),
      end("c2"),
      {
        type: "RUN_FINISHED",
        outcome: { type: "cancelled", pendingToolCallIds: ["c1"] },
        timestamp: 13700,
      },
    ],
    expected: {
      steps: {
        c1: { v: 1, kind: "server", status: "cancelled", startedAt: 13500, settledAt: 13700 },
        c2: { v: 1, kind: "server", status: "cancelled", startedAt: 13600, settledAt: 13700 },
      },
    },
  },
  {
    name: "result-then-failed-step",
    events: [
      start("c1", {
        v: 1,
        kind: "server",
        status: "running",
        label: "Searching the corpus…",
        icon: "search",
        sources: [{ id: "c1:0", kind: "record", title: "corpus/a.md" }],
        startedAt: 14000,
      }),
      end("c1"),
      result("c1"),
      custom({
        v: 1,
        toolCallId: "c1",
        kind: "server",
        status: "failed",
        label: "Search failed",
        icon: "alert",
        settledAt: 14200,
      }),
    ],
    expected: {
      steps: {
        // A thrown tool reads as failed: nothing it showed before survives.
        c1: {
          v: 1,
          kind: "server",
          status: "failed",
          label: "Search failed",
          icon: "alert",
          startedAt: 14000,
          settledAt: 14200,
          error: DEFAULT_ERROR,
        },
      },
    },
  },
  {
    name: "result-error-fails-running-step",
    events: [
      start("c1", {
        v: 1,
        kind: "server",
        status: "running",
        label: "Reading corpus/x.md",
        startedAt: 14500,
      }),
      end("c1"),
      { ...result("c1"), content: "", error: "ENOENT: corpus/x.md" },
    ],
    expected: {
      steps: {
        c1: {
          v: 1,
          kind: "server",
          status: "failed",
          startedAt: 14500,
          error: { message: "ENOENT: corpus/x.md" },
        },
      },
    },
  },
  {
    name: "restart-reopens-cancelled-step",
    events: [
      { type: "RUN_STARTED" },
      start("c1", {
        v: 1,
        kind: "server",
        status: "running",
        label: "Waiting for approval",
        startedAt: 15000,
      }),
      end("c1"),
      start("c2", { v: 1, kind: "server", status: "running", label: "Indexing", startedAt: 15050 }),
      end("c2"),
      {
        type: "RUN_FINISHED",
        outcome: {
          type: "interrupt",
          interrupts: [{ id: "i1", reason: "tool_approval", toolCallId: "c1" }],
        },
        timestamp: 15100,
      },
      // The resume re-presents both calls and runs them.
      { type: "RUN_STARTED" },
      start("c1"),
      end("c1"),
      result("c1", {
        v: 1,
        kind: "server",
        status: "completed",
        label: "Approved and sent",
        settledAt: 15300,
      }),
      start("c2"),
      end("c2"),
      // No step of its own: only the reopen lets the frames complete it.
      result("c2"),
      { type: "RUN_FINISHED", outcome: { type: "success" }, timestamp: 15500 },
    ],
    expected: {
      steps: {
        c1: {
          v: 1,
          kind: "server",
          status: "completed",
          label: "Approved and sent",
          startedAt: 15000,
          settledAt: 15300,
        },
        c2: { v: 1, kind: "server", status: "completed", startedAt: 15050 },
      },
    },
  },
  {
    name: "late-result-keeps-cancelled",
    events: [
      { type: "RUN_STARTED" },
      start("c1", {
        v: 1,
        kind: "server",
        status: "running",
        label: "Waiting for approval",
        startedAt: 16000,
      }),
      end("c1"),
      start("c2", { v: 1, kind: "server", status: "running", label: "Indexing", startedAt: 16050 }),
      end("c2"),
      {
        type: "RUN_FINISHED",
        outcome: {
          type: "interrupt",
          interrupts: [{ id: "i1", reason: "tool_approval", toolCallId: "c1" }],
        },
        timestamp: 16100,
      },
      // The next run delivers a late result for c2 without presenting it again.
      { type: "RUN_STARTED" },
      result("c2"),
    ],
    expected: {
      steps: {
        c1: {
          v: 1,
          kind: "server",
          status: "running",
          label: "Waiting for approval",
          startedAt: 16000,
        },
        c2: { v: 1, kind: "server", status: "cancelled", startedAt: 16050, settledAt: 16100 },
      },
    },
  },
  {
    name: "held-step-dropped-at-run-end",
    events: [
      { type: "RUN_STARTED" },
      // A step for a call this run never starts.
      custom({ v: 1, toolCallId: "c1", kind: "server", status: "running", label: "Ghost label" }),
      { type: "RUN_FINISHED", outcome: { type: "success" }, timestamp: 17000 },
      { type: "RUN_STARTED" },
      start("c1"),
      end("c1"),
    ],
    expected: {
      steps: {
        c1: { v: 1, kind: "server", status: "running" },
      },
    },
  },
  {
    name: "completed-without-label-drops-running-label",
    events: [
      start("c1", {
        v: 1,
        kind: "server",
        status: "running",
        label: "Searching flights",
        icon: "search",
        queries: ["SFO to JFK"],
        sources: [{ id: "c1:0", kind: "record", title: "Fare table" }],
        startedAt: 18000,
      }),
      end("c1"),
      // The settle restates neither the label nor the sources.
      custom({ v: 1, toolCallId: "c1", kind: "server", status: "completed", settledAt: 18500 }),
      result("c1"),
    ],
    expected: {
      steps: {
        c1: {
          v: 1,
          kind: "server",
          status: "completed",
          icon: "search",
          queries: ["SFO to JFK"],
          startedAt: 18000,
          settledAt: 18500,
        },
      },
    },
  },
  {
    name: "late-running-adds-nothing-to-settled",
    events: [
      start("c1", {
        v: 1,
        kind: "server",
        status: "running",
        label: "Sending invoice",
        startedAt: 19000,
      }),
      end("c1"),
      custom({
        v: 1,
        toolCallId: "c1",
        kind: "server",
        status: "completed",
        label: "Sent invoice",
        settledAt: 19400,
      }),
      // A running write that arrives late says nothing about a settled step.
      custom({
        v: 1,
        toolCallId: "c1",
        kind: "server",
        status: "running",
        label: "Still sending",
        icon: "mail",
        queries: ["late"],
      }),
      result("c1"),
    ],
    expected: {
      steps: {
        c1: {
          v: 1,
          kind: "server",
          status: "completed",
          label: "Sent invoice",
          startedAt: 19000,
          settledAt: 19400,
        },
      },
    },
  },
]
