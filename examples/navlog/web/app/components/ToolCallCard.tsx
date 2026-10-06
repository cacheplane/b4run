"use client"
import type { B4StepEventValue } from "@b4run/ag-ui/view"
import { useRenderTool } from "@copilotkit/react-core/v2"
import { createContext, type ReactNode, useContext, useId, useState } from "react"
import {
  humanizeToolName,
  outcomeFromResult,
  presentTool,
  type ToolOutcome,
} from "../lib/tool-presentation"

// CopilotKit 1.76 V2 notes (verified against the installed
// @copilotkit/react-core dist; the bundled filenames carry content hashes that
// change between releases, so none is cited here):
//
// - The registration hook is `useRenderTool` (NOT `useRenderToolCall` — that
//   one takes no args and returns a `({toolCall, toolMessage}) => ReactElement`
//   render *function*; `Transcript` uses it). `useRenderTool` is called under
//   `<CopilotKit>`.
// - Wildcard registration: `{ name: "*", render, agentId? }` is the fallback
//   when no exact tool-name renderer is registered.
// - The wildcard overload types `render` props as `any`. The runtime passes
//   `{ name, toolCallId, args, parameters, status, result }` — `parameters` is
//   `args` copied by `useRenderTool` — with status `"inProgress"`,
//   `"executing"` or `"complete"`, and `result` populated for completed calls.
//   Treat that as the current runtime contract, not a typed guarantee.
//
// With no agentId, this binds to CopilotKit's default agent id ("default"),
// which the runtime route registers as our B4.run /navlog agent.

/** The three states `useRenderTool` reports a call in. */
export type ToolCallStatus = "inProgress" | "executing" | "complete"

export interface ToolCallViewProps {
  readonly name: string
  readonly status: ToolCallStatus
  readonly parameters: unknown
  readonly result?: string | undefined
  /** Keys the call's `b4.step` (from `ToolStepsContext`) when the live stream sent one. */
  readonly toolCallId?: string | undefined
  /** Starts with the Details disclosure open. For tests and stories; the app never sets it. */
  readonly defaultExpanded?: boolean
}

/**
 * The `b4.step` events the live stream carried for root tool calls, by
 * `toolCallId`. `Transcript` subscribes to the agent and provides it; the card
 * reads it for two things the result text cannot say on its own: that the
 * server marked the call failed or denied, and a server-written label for a tool
 * `presentTool` has no wording for. A restored conversation has no steps (they
 * are not persisted), so everything here degrades to the client-side wording.
 */
export const ToolStepsContext = createContext<ReadonlyMap<string, B4StepEventValue>>(new Map())

/**
 * Unwrap a tool call's arguments.
 *
 * THIS IS FOR THE LIVE AG-UI STREAM ONLY, where there are TWO shapes, not one
 * (`app/lib/hydrate.ts`'s header states the same pair from the other side).
 * The dominant `on_chat_model_end` path announces a root tool call's args as a
 * real object; the held `on_tool_start` path carries LangGraph's own `{input}`
 * wrapper, whose value is itself a JSON string. Unwrapping is what keeps the
 * card from showing double-encoded JSON.
 *
 * The checkpoint shape (`GET /threads/:id/state`) is converted by
 * `app/lib/hydrate.ts` before anything reaches this card, deliberately, so this
 * function never has to guess which format it is holding.
 */
export function parseArgs(parameters: unknown): Record<string, unknown> {
  const p = (parameters ?? {}) as Record<string, unknown>
  if (typeof p.input === "string") {
    try {
      const inner = JSON.parse(p.input)
      if (inner && typeof inner === "object") return inner as Record<string, unknown>
    } catch {
      // Not JSON — fall through and show the raw string.
    }
  }
  return p
}

/**
 * Tidy a tool result for the Details view. A tool that returned JSON is
 * pretty-printed — except a `{ content }` wrapper around one document
 * (`readDoc`), which shows the document itself rather than one long escaped
 * string. Plain text passes through untouched.
 */
function formatResult(result: string | undefined): string | undefined {
  if (!result) return undefined
  try {
    const parsed: unknown = JSON.parse(result)
    if (parsed !== null && typeof parsed === "object") {
      const keys = Object.keys(parsed)
      const content = (parsed as { content?: unknown }).content
      if (keys.length === 1 && typeof content === "string") return content
      return JSON.stringify(parsed, null, 2)
    }
  } catch {
    // Not JSON: show it as-is.
  }
  return result
}

/**
 * How many characters of a result the Details view will show. A tool can return
 * a whole document; the card is a summary, not a viewer.
 */
export const RESULT_PREVIEW_LIMIT = 400

/** The outcome a card shows, from the lifecycle, the server's step, and the result text. */
export function cardOutcome(
  status: ToolCallStatus,
  result: string | undefined,
  step: B4StepEventValue | undefined,
): ToolOutcome {
  if (step?.status === "failed") return "error"
  if (step?.status === "denied") return "denied"
  if (status !== "complete") return "running"
  return outcomeFromResult(result)
}

const OUTCOME_LABEL: Record<ToolOutcome, string> = {
  running: "Running",
  done: "Done",
  error: "Failed",
  denied: "Denied",
}

/**
 * The status mark: a spinner while running, a check when done, a cross on an
 * error, a slashed circle when the person denied it. Drawn rather than glyphs
 * so the four share one size and stroke. The finished check stays MUTED: a
 * result with no error text is "finished", which is not the same claim as
 * "succeeded" (the wire carries no success flag), so it does not borrow the
 * package's green.
 */
const MARK: Record<ToolOutcome, { readonly className: string; readonly shapes: ReactNode }> = {
  running: {
    className: "text-[var(--b4-activity-running,currentColor)] motion-safe:animate-spin",
    shapes: (
      <>
        <circle cx="8" cy="8" r="6" opacity="0.25" />
        <path d="M14 8a6 6 0 0 0-6-6" />
      </>
    ),
  },
  done: {
    className: "text-wb-muted",
    shapes: (
      <>
        <circle cx="8" cy="8" r="6.25" opacity="0.35" />
        <path d="M5.25 8.25 7.1 10l3.65-4" />
      </>
    ),
  },
  error: {
    className: "text-[var(--wb-chat-danger)]",
    shapes: (
      <>
        <circle cx="8" cy="8" r="6.25" />
        <path d="m6 6 4 4M10 6l-4 4" />
      </>
    ),
  },
  denied: {
    className: "text-[var(--wb-chat-warn)]",
    shapes: (
      <>
        <circle cx="8" cy="8" r="6.25" />
        <path d="m3.6 12.4 8.8-8.8" />
      </>
    ),
  },
}

function StatusMark({ outcome }: { outcome: ToolOutcome }) {
  const { className, shapes } = MARK[outcome]
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={OUTCOME_LABEL[outcome]}
      className={`shrink-0 ${className}`}
    >
      <title>{OUTCOME_LABEL[outcome]}</title>
      {shapes}
    </svg>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
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
      className={`shrink-0 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
    >
      <path d="m3 4.5 3 3 3-3" />
    </svg>
  )
}

const PRE =
  "whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.6] text-wb-text [overflow-wrap:anywhere]"

/**
 * One tool call, as a pilot reads it: a status mark, a plain title ("Current
 * weather (METAR) for KFCM, KDLH"), a one-line summary of what came back
 * ("2 airports VFR") — and the raw arguments and result behind a "Details"
 * disclosure for whoever wants them.
 *
 * The exact tool name stays on the card as a small monospace tag, and that is
 * load-bearing beyond being honest about what ran: the workbench journeys find
 * a card by it (`getByText("computeNavlog", { exact: true })`, exactly one per
 * call). So it is its own text node, and nothing else on the card may be that
 * same string.
 *
 * The disclosure is a BUTTON, not `<details>`: the journeys also assert that a
 * root tool's name appears inside no `<details>` (that is how they tell a root
 * call from one a subagent made, whose cards are the package's `<details>`), and
 * a button keeps the raw view out of that count entirely. Its panel is rendered
 * only while open, so a long result costs nothing until someone asks for it.
 *
 * Ordinary Tailwind utilities are fine here — no package stylesheet touches
 * this markup (unlike `PlanCard`, see `activity-renderers.tsx`).
 */
export function ToolCallView({
  name,
  status,
  parameters,
  result,
  toolCallId,
  defaultExpanded = false,
}: ToolCallViewProps) {
  const steps = useContext(ToolStepsContext)
  const step = toolCallId === undefined ? undefined : steps.get(toolCallId)
  const [expanded, setExpanded] = useState(defaultExpanded)
  const panelId = useId()
  const args = parseArgs(parameters)
  const outcome = cardOutcome(status, result, step)
  const finished = status === "complete"
  const presentation = presentTool(
    name,
    args,
    finished ? result : undefined,
    finished ? "done" : "running",
  )
  // The server's label only stands in for a tool this client has no wording
  // for (its title is just the humanized name): it is not persisted, so leaning
  // on it for known tools would make a restored card read differently from the
  // live one, and for a tool with a client title it mostly repeats that title.
  const isUnknownTool = presentation.title === humanizeToolName(name)
  const summary =
    outcome === "denied"
      ? "You denied this request"
      : (presentation.summary ?? (isUnknownTool ? step?.label : undefined))

  const content = finished ? formatResult(result) : undefined
  // UTF-16 units, so an emoji straddling the limit can split. Acceptable for a
  // bounded preview.
  const preview = content?.slice(0, RESULT_PREVIEW_LIMIT)
  const hidden = content === undefined ? 0 : content.length - (preview?.length ?? 0)
  const argsText = Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : undefined

  return (
    <div
      data-tool-card=""
      data-outcome={outcome}
      className="rounded-wb border border-wb-border bg-wb-surface text-[13px] tracking-tight"
    >
      <div className="flex items-start gap-2.5 px-3 pt-2.5 pb-2">
        <span className="mt-0.5 flex">
          <StatusMark outcome={outcome} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 font-medium leading-5 [overflow-wrap:anywhere]">
              {presentation.title}
            </p>
            {/*
              The tool's real name. Its own text node — see the component doc.
              `overflow-wrap: anywhere` (not `break-all`) so a long name breaks
              only when it cannot fit.
            */}
            <code className="mt-px shrink-0 rounded-[5px] border border-wb-border bg-wb-bg px-1.5 py-px font-mono text-[10.5px] leading-4 text-wb-muted [overflow-wrap:anywhere]">
              {name}
            </code>
          </div>
          <div className="mt-0.5 flex items-start gap-2">
            <p className="min-w-0 flex-1 text-[12.5px] leading-5 text-wb-muted [overflow-wrap:anywhere]">
              {summary ?? (outcome === "running" ? "Working…" : null)}
            </p>
            {argsText !== undefined || preview !== undefined ? (
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={panelId}
                onClick={() => setExpanded((open) => !open)}
                className="wb-focus -my-1 -mr-1.5 inline-flex shrink-0 items-center gap-1 rounded-wb-sm px-1.5 py-1 text-[11.5px] font-medium text-wb-muted transition-colors hover:text-wb-text pointer-coarse:min-h-11"
              >
                Details
                <Chevron open={expanded} />
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {expanded ? (
        <div id={panelId} className="space-y-2 border-t border-wb-border px-3 py-2.5">
          {argsText !== undefined ? (
            <div>
              <p className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.08em] text-wb-muted">
                Input
              </p>
              <pre
                className={`${PRE} max-h-[160px] overflow-auto rounded-wb-sm bg-wb-bg px-2 py-1.5`}
              >
                {argsText}
              </pre>
            </div>
          ) : null}
          {preview !== undefined ? (
            <div>
              <p className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.08em] text-wb-muted">
                Result
              </p>
              {/*
                `tabIndex={0}` + a named region: this box scrolls, and Safari
                does not make scrollable containers keyboard-focusable on its
                own, so without it a keyboard user cannot reach a long result.
              */}
              <section
                // biome-ignore lint/a11y/noNoninteractiveTabindex: scroll container
                tabIndex={0}
                aria-label={`${name} result`}
                className="wb-focus max-h-[200px] overflow-auto rounded-wb-sm bg-wb-bg px-2 py-1.5"
              >
                <pre className={PRE}>{preview}</pre>
              </section>
              {hidden > 0 ? (
                <p className="mt-1 text-[11px] tabular-nums text-wb-muted">
                  +{hidden} more characters
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function ToolCallCard() {
  useRenderTool(
    {
      name: "*",
      render: ({ name, status, parameters, result, toolCallId }) => (
        <ToolCallView
          name={name}
          status={status}
          parameters={parameters}
          result={result}
          toolCallId={toolCallId}
        />
      ),
    },
    [],
  )
  return null
}
