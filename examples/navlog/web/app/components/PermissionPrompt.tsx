"use client"
import { type ReactNode, useEffect, useRef } from "react"
import { flightPlanSummary } from "../lib/tool-presentation"
import { neutralButton } from "./ui"

/**
 * The B4.run interrupt envelope, as the workbench reads it.
 *
 * One type for BOTH sources, and that is the point of this file. A live gate
 * arrives as `Interrupt.metadata`, where `@b4run/ag-ui`'s `toAguiInterrupt`
 * parks the whole envelope verbatim; a reloaded gate arrives as `value` from
 * `GET /threads/:id/pending_interrupts`, which is that same envelope before
 * anything mapped it. So the card can be written once against the envelope and
 * never learn which source it came from — `PermissionInterrupt` and
 * `HydratedInterrupts` differ only in how a decision is sent back.
 *
 * `message` is on the envelope type rather than read off `Interrupt.message`
 * for exactly that reason: `toAguiInterrupt` copies it FROM the envelope, so
 * reading the envelope is equivalent for a live gate and possible for a
 * hydrated one.
 */
export type PermissionMetadata = {
  kind?: string
  message?: string
  detail?: {
    /**
     * Open, like `B4InterruptEnvelope` itself. The named fields below are the
     * ones this card reads; a gate kind it has no branch for still carries its
     * own detail (`kind: "memory"` brings `namespace`/`oldContent`/…), and
     * modelling that away would make a real envelope a type error at every
     * call site rather than the fallback `subjectOf` handles.
     */
    readonly [key: string]: unknown
    command?: string
    toolName?: string
    argsPreview?: string
    path?: string
    operation?: string
    suggestedPattern?: string
    parentRouteId?: string
    subagentName?: string
    subagentRouteId?: string
    inputPreview?: string
    reason?: string
  }
  readonly [key: string]: unknown
}

export type PermissionDecision = "once" | "always" | "deny"

export interface PermissionPromptProps {
  /** The B4.run interrupt envelope — `Interrupt.metadata` live, or `value` from the endpoint. */
  readonly metadata: PermissionMetadata
  /** True while this card's decision is in flight. */
  readonly isResolving: boolean
  /**
   * What the user chose. Deliberately NOT `resolve`/`cancel`: the two sources
   * resume differently — the live one through CopilotKit's interrupt handle,
   * the hydrated one through `copilotkit.runAgent({ resume })` — so mapping a
   * decision onto the wire is the caller's job and the card stays pure.
   */
  readonly onDecide: (decision: PermissionDecision) => void
  /**
   * Whether this card takes the keyboard when it mounts. Callers pass true for
   * the first card of a group only, so a turn parked on two gates does not
   * have its second card steal focus from its first — and the hydrated source
   * passes false for every card, because it appears without the user asking.
   */
  readonly autoFocus?: boolean
  /**
   * The interrupt's id, used only to decide whether focus has already been
   * given to THIS gate.
   *
   * Belt and braces with the `key` every caller puts on the card: the key
   * already forces a remount per interrupt id, which would make a plain
   * once-per-mount flag equivalent. Comparing ids keeps the behavior correct —
   * focus once per interrupt, never re-stolen — even for a caller that
   * re-renders one card in place with a new gate in it.
   */
  readonly focusKey?: string
}

const ROW = "mt-1 text-[13px] leading-5 text-wb-muted"
const CODE = "rounded bg-wb-bg px-1 py-0.5 font-mono text-[12px] text-wb-text"
const BUTTON = `${neutralButton("sm")} inline-flex min-h-8 items-center pointer-coarse:min-h-11 pointer-coarse:px-4`
/** The card's first, affirmative decision: the one filled button, in the text color. */
const PRIMARY_BUTTON =
  "wb-focus inline-flex min-h-8 items-center rounded-wb-sm border border-transparent bg-wb-text px-2.5 py-1 text-[12px] font-medium tracking-tight text-wb-bg transition-opacity hover:opacity-90 pointer-coarse:min-h-11 pointer-coarse:px-4"

/** The tool whose gate this card describes in pilot terms rather than as a tool name. */
export const FLIGHT_PLAN_TOOL = "fileFlightPlan"

export const FLIGHT_PLAN_NOTE =
  "Recorded in the demo workspace — not transmitted to Flight Service."

/**
 * A `fileFlightPlan` gate's arguments in one line, read from the gate's
 * `argsPreview` — the call's arguments as JSON, cut at 500 characters by the
 * server (`buildArgsPreview` in `packages/core`). A cut or unreadable preview
 * yields undefined and the card falls back to naming the tool.
 */
export function flightPlanGateSummary(argsPreview: string | undefined): string | undefined {
  if (argsPreview === undefined) return undefined
  let args: unknown
  try {
    args = JSON.parse(argsPreview)
  } catch {
    return undefined
  }
  if (typeof args !== "object" || args === null) return undefined
  const line = flightPlanSummary((args as { flightPlan?: unknown }).flightPlan)
  return line === undefined ? undefined : `Record flight plan ${line}`
}

/**
 * The note above a group of cards. Rendered by whichever source owns the group
 * — shared here so the two sources cannot drift into two different wordings of
 * the same fact.
 */
export function MultipleGatesNotice({ count }: { count: number }) {
  if (count <= 1) return null
  return (
    <p className="text-[13px] text-wb-muted">
      This turn stopped on {count} requests. The run continues once every one of them is answered.
    </p>
  )
}

/**
 * The gate's own surface, deliberately NOT the workbench's neutral card: it is
 * the one thing in the transcript that stops the run and waits on a person, so
 * it carries an amber edge and a filled ground the rest of the app never uses.
 * (It borrows no gradient — that stays reserved for the brand mark and the send
 * button.)
 *
 * A real component rather than markup inlined in a `render` callback so it can
 * own an effect: the card arrives at the bottom of a scrolling region, the
 * composer goes inert at the same moment, and neither event moves focus or says
 * anything. `role="alert"` announces it, and the effect puts the keyboard on
 * the first decision — otherwise a keyboard-only user is left tabbing through
 * a dead composer with no indication of why it stopped responding.
 *
 * The effect focuses once per INTERRUPT, guarded by an id-comparing ref so a
 * re-render (a resolving state change, a parent re-render mid-run) cannot
 * re-steal focus the user has since moved, while a genuinely new gate still
 * gets it. Only the live source asks for this at all — see `autoFocus`.
 */
function InterruptCard({
  title,
  autoFocus,
  focusKey,
  isResolving,
  children,
  actions,
}: {
  title: string
  autoFocus: boolean
  focusKey: string
  isResolving: boolean
  children: ReactNode
  actions: ReactNode
}) {
  const actionsRef = useRef<HTMLDivElement>(null)
  const focusedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!autoFocus || focusedRef.current === focusKey) return
    focusedRef.current = focusKey
    actionsRef.current?.querySelector("button")?.focus()
  }, [autoFocus, focusKey])

  return (
    <div
      role="alert"
      aria-busy={isResolving}
      className="rounded-wb border border-amber-500/40 bg-[var(--wb-chat-warn-bg)] px-3.5 py-3 text-[13px]"
    >
      <p className="flex items-center gap-2 text-[13px] font-semibold tracking-tight">
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0 text-[var(--wb-chat-warn)]"
        >
          <path d="M7 1.5 1.25 12h11.5L7 1.5ZM7 5.5v3M7 10.25v.25" />
        </svg>
        {title}
      </p>
      {children}
      <div
        ref={actionsRef}
        // Inert, not disabled: `disabled` would drop focus to <body> the
        // instant the user's own click starts the resume.
        className={`mt-3 flex flex-wrap gap-2 ${isResolving ? "pointer-events-none opacity-50" : ""}`}
      >
        {actions}
      </div>
    </div>
  )
}

/**
 * What the gate is actually asking about, in one line.
 *
 * Only `kind: "command"` envelopes carry `detail.command`, and the previous
 * version of this card fell all the way through to `JSON.stringify(metadata)`
 * for every other kind — so a tool gate, the most common one this app raises,
 * rendered the raw envelope (interruptId and all) inside the `<code>` element.
 * Each branch below reads the field the corresponding `emitPermissionInterrupt`
 * branch in `packages/core/src/capabilities/permission-gate.ts` actually
 * writes.
 *
 * The last resort is a fixed phrase, NOT the stringified envelope: dumping it
 * is the same defect one line up, and it puts an interruptId and a machine
 * `type` in front of someone being asked to make a security decision. The kind
 * still prefixes the line, so an unrecognized gate reads as "memory: an
 * unrecognized request" — thin, but honest, and the buttons still work.
 *
 * TODO: `kind: "memory"` is exactly that case today. Its detail carries
 * `namespace`, `identity`, `oldContent` and `newContent` — a belief the agent
 * wants to supersede — which deserves its own branch showing the old and new
 * text rather than this fallback. Still deferred: the memory-in-the-workbench
 * slice restored the candidate panel (`MemoryPanel.tsx`), which is the review
 * queue, not this in-run supersede gate.
 */
const UNRECOGNIZED = "an unrecognized request"

function subjectOf(metadata: PermissionMetadata): string {
  const detail = metadata.detail
  const path =
    detail?.path === undefined
      ? undefined
      : detail.operation === undefined
        ? detail.path
        : `${detail.operation} ${detail.path}`
  return detail?.command ?? detail?.toolName ?? path ?? metadata.message ?? UNRECOGNIZED
}

/**
 * One permission gate, from either source.
 *
 * The two branches match the two shapes B4.run's gate emits that this app can
 * say something useful about: a subagent dispatch (which names a parent route
 * and a child) and everything else (a command, a tool, a path).
 */
export function PermissionPrompt({
  metadata,
  isResolving,
  onDecide,
  autoFocus = true,
  focusKey = "",
}: PermissionPromptProps) {
  const deny = (
    <button
      type="button"
      className={BUTTON}
      aria-disabled={isResolving}
      onClick={() => onDecide("deny")}
    >
      Deny
    </button>
  )
  const allow = (decision: "once" | "always", label: string) => (
    <button
      type="button"
      className={decision === "once" ? PRIMARY_BUTTON : BUTTON}
      aria-disabled={isResolving}
      onClick={() => onDecide(decision)}
    >
      {label}
    </button>
  )

  if (metadata.kind === "subagent") {
    const detail = metadata.detail
    return (
      <InterruptCard
        title="Subagent approval required"
        autoFocus={autoFocus}
        focusKey={focusKey}
        isResolving={isResolving}
        actions={
          <>
            {allow("once", "Once")}
            {allow("always", "Always")}
            {deny}
          </>
        }
      >
        <p className={ROW}>
          Parent <code className={CODE}>{detail?.parentRouteId ?? "unknown route"}</code> wants to
          dispatch <code className={CODE}>{detail?.subagentName ?? "an unknown subagent"}</code>
          {detail?.subagentRouteId ? ` (${detail.subagentRouteId})` : null}.
        </p>
        <p className={ROW}>Input: {detail?.inputPreview ?? "no input preview"}</p>
        {detail?.reason ? <p className={ROW}>Reason: {detail.reason}</p> : null}
      </InterruptCard>
    )
  }

  // Filing a flight plan, said as what it is. Only "Allow once": a standing
  // approval to file every future plan is not a decision anyone should make
  // from a demo card, so "Allow always" is not offered for this tool. The tool
  // name stays on the card (as a tag) — the journeys find the gate by it.
  const flightPlanLine =
    metadata.kind === "tool" && metadata.detail?.toolName === FLIGHT_PLAN_TOOL
      ? flightPlanGateSummary(metadata.detail.argsPreview)
      : undefined
  if (metadata.kind === "tool" && metadata.detail?.toolName === FLIGHT_PLAN_TOOL) {
    return (
      <InterruptCard
        title="Record this flight plan?"
        autoFocus={autoFocus}
        focusKey={focusKey}
        isResolving={isResolving}
        actions={
          <>
            {allow("once", "Allow once")}
            {deny}
          </>
        }
      >
        <p className="mt-1.5 text-[13px] leading-5 text-wb-text [overflow-wrap:anywhere]">
          {flightPlanLine ?? "Record a flight plan"}
        </p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-5 text-wb-muted">
          <span>{FLIGHT_PLAN_NOTE}</span>
          <code className="rounded-[5px] border border-wb-border bg-wb-bg px-1.5 py-px font-mono text-[10.5px] leading-4">
            {FLIGHT_PLAN_TOOL}
          </code>
        </p>
      </InterruptCard>
    )
  }

  return (
    <InterruptCard
      title="Permission required"
      autoFocus={autoFocus}
      focusKey={focusKey}
      isResolving={isResolving}
      actions={
        <>
          {allow("once", "Allow once")}
          {allow("always", "Allow always")}
          {deny}
        </>
      }
    >
      <p className={ROW}>
        {metadata.kind ? `${metadata.kind}: ` : ""}
        <code className={CODE}>{subjectOf(metadata)}</code>
      </p>
    </InterruptCard>
  )
}
