"use client"
import type { s } from "@hashbrownai/core"
import { type ExposedComponent, exposeComponent } from "@hashbrownai/react"
import { type ComponentType, createContext, Fragment, type ReactNode, useContext } from "react"
import { neutralButton } from "../components/ui"
import { VerdictIcon } from "../components/VerdictCard"
import { inlineSegments, stripToolEchoes, textBlocks } from "../lib/assistant-text"
import { type EffectiveVerdict, isWorse, outrankNote } from "../lib/verdict"
import {
  type AssumptionOrigin,
  type AssumptionsProps,
  assumptionsDefinition,
  type BottomLineProps,
  bottomLineDefinition,
  type Citation,
  type CitationsProps,
  citationsDefinition,
  type KeyNumbersProps,
  keyNumbersDefinition,
  type ProseProps,
  proseDefinition,
  type RouteSummaryProps,
  routeSummaryDefinition,
  type WatchForProps,
  type WatchSeverity,
  watchForDefinition,
} from "./schema"

/**
 * The planning brief's components: what the model's structured answer
 * renders as, in the chat and in the sheet's Brief tab. Each takes the props
 * its definition in `schema.ts` describes; `briefComponents` pairs them for
 * hashbrown's `useUiKit`.
 *
 * In the chat an answer renders inside CopilotKit's `cpk:prose` wrapper,
 * whose typography would indent the lists, space the headings and indent the
 * `dd`s; every structured component's root is `not-prose` (the opt-out the
 * wrapper's selectors check), and only `Prose` keeps the prose look.
 */

/** Opts a component out of the chat's `cpk:prose` typography. */
const ROOT = "not-prose mt-3 first:mt-0"

/**
 * The answer's citation list, provided by whatever renders the answer, so a
 * claim's `cite: ["c1"]` becomes a numbered marker linking to its entry.
 * `idPrefix` keeps the anchors unique when several answers share a page.
 */
export interface CitationsContextValue {
  readonly items: readonly Citation[]
  readonly idPrefix: string
}

export const CitationsContext = createContext<CitationsContextValue>({ items: [], idPrefix: "" })

/** What the brief's controls do; the chat provides them. */
export interface BriefActions {
  /** An assumption's "Change": the chat fills the composer to correct it. */
  readonly changeAssumption: (statement: string) => void
  /** True while Change cannot act (an approval is open and the composer waits). */
  readonly changeDisabled: boolean
}

/**
 * Null where nothing acts on the controls (the sheet's Brief tab), and the
 * controls are left out there rather than drawn inert.
 */
export const BriefActionsContext = createContext<BriefActions | null>(null)

/**
 * The verdict the sheet's card shows (`resolveVerdict`), when the answer
 * renders under it. A worse verdict than the bottom line's own replaces its
 * level, with the planner's call noted, so the two never disagree.
 */
export const BriefVerdictContext = createContext<EffectiveVerdict | null>(null)

/** Renders a markdown string. The chat can swap in its own renderer. */
export type BriefMarkdownRenderer = (props: { readonly content: string }) => ReactNode

function Inline({ text }: { readonly text: string }) {
  return (
    <>
      {inlineSegments(text).map((segment, i) =>
        segment.bold ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one immutable string
          <strong key={i}>{segment.text}</strong>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one immutable string
          <Fragment key={i}>{segment.text}</Fragment>
        ),
      )}
    </>
  )
}

/** The default: paragraphs, headings, lists and bold, with the `.wb-prose` look. */
function PlainMarkdown({ content }: { readonly content: string }) {
  return (
    <div className="wb-prose">
      {textBlocks(content).map((block, i) => {
        const key = `${block.kind}-${i}`
        if (block.kind === "heading") {
          return (
            <h4 key={key}>
              <Inline text={block.text} />
            </h4>
          )
        }
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul"
          return (
            <List key={key}>
              {block.items.map((item) => (
                <li key={item}>
                  <Inline text={item} />
                </li>
              ))}
            </List>
          )
        }
        return (
          <p key={key}>
            <Inline text={block.text} />
          </p>
        )
      })}
    </div>
  )
}

export const BriefMarkdownContext = createContext<BriefMarkdownRenderer>(PlainMarkdown)

function citeAnchor(idPrefix: string, id: string): string {
  return `${idPrefix}cite-${id}`
}

/** Superscript markers for a claim's citations; an id the answer does not list draws none. */
function CiteMarks({ ids }: { readonly ids: readonly string[] }) {
  const { items, idPrefix } = useContext(CitationsContext)
  return (
    <>
      {ids.map((id) => {
        const index = items.findIndex((item) => item.id === id)
        if (index < 0) return null
        return (
          <sup key={id} className="wb-cite">
            <a
              href={`#${citeAnchor(idPrefix, id)}`}
              aria-label={`Source ${index + 1}`}
              className="wb-focus"
            >
              {index + 1}
            </a>
          </sup>
        )
      })}
    </>
  )
}

function Heading({ children }: { readonly children: ReactNode }) {
  return <h4 className="wb-eyebrow">{children}</h4>
}

export function BottomLine({ level, reason, cite }: BottomLineProps) {
  const verdict = useContext(BriefVerdictContext)
  const outranked = verdict !== null && isWorse(verdict.level, level) ? verdict : null
  const shown = outranked?.level ?? level
  return (
    <section aria-label="Bottom line" className={`wb-bottom-line ${ROOT}`}>
      <span className="wb-eyebrow mr-1.5 inline">Bottom line</span>
      <span className="wb-verdict-pill mr-1.5 align-middle" data-level={shown}>
        <VerdictIcon level={shown} className="size-3.5 shrink-0" />
        <span>{shown}</span>
      </span>
      {reason}
      <CiteMarks ids={cite} />
      {outranked !== null ? (
        <span className="wb-bottom-line-note">{outrankNote(level, outranked)}</span>
      ) : null}
    </section>
  )
}

export function RouteSummary({ from, to, via, altitudeFt, departureUtc }: RouteSummaryProps) {
  const stops = [from, ...via, to]
  return (
    <section aria-label="Route" className={ROOT}>
      <Heading>Route</Heading>
      <ol className="mt-1 flex flex-wrap items-center gap-1.5">
        {stops.map((stop, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a route may pass the same fix twice
          <li key={`${stop}-${i}`} className="flex items-center gap-1.5">
            {i > 0 ? (
              <span aria-hidden="true" className="text-wb-muted">
                →
              </span>
            ) : null}
            <span className="rounded-full border border-wb-border px-2 py-0.5 font-mono text-[12px]">
              {stop}
            </span>
          </li>
        ))}
      </ol>
      <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
        <div className="flex gap-1.5">
          <dt className="text-wb-muted">Altitude</dt>
          <dd className="font-mono tabular-nums">{`${altitudeFt.toLocaleString("en-US")} ft`}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-wb-muted">Departure</dt>
          <dd className="font-mono tabular-nums">{departureUtc}</dd>
        </div>
      </dl>
    </section>
  )
}

const SEVERITY_LABEL: Record<WatchSeverity, string> = {
  info: "Info",
  caution: "Caution",
  danger: "Danger",
}

export function WatchFor({ items }: WatchForProps) {
  return (
    <section aria-label="Watch for" className={ROOT}>
      <Heading>Watch for</Heading>
      {items.length === 0 ? (
        <p className="mt-1 text-[13px] text-wb-muted">Nothing during the flight</p>
      ) : (
        <ul className="mt-1 grid gap-1 text-[13px] leading-snug">
          {items.map((item, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: two items may say the same thing
              key={`${i}-${item.what}`}
              className="flex items-baseline gap-2"
              data-severity={item.severity}
            >
              <span aria-hidden="true" className="wb-watch-dot" data-severity={item.severity} />
              {/* The word, not only the dot's colour, says how much it matters. */}
              <span className="wb-watch-severity" data-severity={item.severity}>
                {SEVERITY_LABEL[item.severity]}
              </span>
              {/* The window goes under the hazard, so a long one never squeezes it. */}
              <span className="min-w-0 flex-1">
                {item.what}
                <CiteMarks ids={item.cite} />
                {item.when !== null ? (
                  <span className="block font-mono text-[12px] tabular-nums text-wb-muted">
                    {item.when}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function KeyNumbers({ items }: KeyNumbersProps) {
  if (items.length === 0) return null
  return (
    <section aria-label="Key numbers" className={ROOT}>
      <Heading>Key numbers</Heading>
      <dl className="wb-stats mt-1">
        {items.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: two figures may share a label
          <div key={`${i}-${item.label}`} className="wb-stat">
            <dt>{item.label}</dt>
            <dd>
              <span className="font-mono tabular-nums">{item.value}</span>
              {item.unit !== null ? (
                <span className="ml-1 text-[12px] font-medium text-wb-muted">{item.unit}</span>
              ) : null}
              <CiteMarks ids={item.cite} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

const ORIGIN_LABEL: Record<AssumptionOrigin, string> = {
  pilot: "You said",
  memory: "From memory",
  default: "Default",
}

export function Assumptions({ items }: AssumptionsProps) {
  const actions = useContext(BriefActionsContext)
  if (items.length === 0) return null
  return (
    <section aria-label="Assumptions" className={ROOT}>
      <Heading>Assumptions</Heading>
      <ul className="mt-1 grid gap-1 text-[13px] leading-snug">
        {items.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: two assumptions may read the same
          <li key={`${i}-${item.statement}`} className="wb-row flex items-center gap-2">
            <span className="min-w-0 flex-1">{item.statement}</span>
            <span
              className="shrink-0 rounded-full border border-wb-border px-2 text-[11px] text-wb-muted"
              data-origin={item.origin}
            >
              {ORIGIN_LABEL[item.origin]}
            </span>
            {actions !== null ? (
              <button
                type="button"
                className={`${neutralButton("sm")} shrink-0 print:hidden`}
                aria-label={`Change: ${item.statement}`}
                disabled={actions.changeDisabled}
                onClick={() => actions.changeAssumption(item.statement)}
              >
                Change
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function Citations({ items }: CitationsProps) {
  const { idPrefix } = useContext(CitationsContext)
  return (
    <section aria-label="Sources" className={ROOT}>
      <Heading>Sources</Heading>
      <ol className="mt-1 grid list-decimal gap-0.5 pl-5 text-[12px] leading-snug text-wb-muted">
        {items.map((item) => (
          <li key={item.id} id={citeAnchor(idPrefix, item.id)} className="wb-cite-entry">
            <span className="font-mono text-wb-text">{item.source}</span>
            {item.locator !== "" ? <span>{` · ${item.locator}`}</span> : null}
          </li>
        ))}
      </ol>
    </section>
  )
}

/**
 * Markdown, with the plumbing a model echoes into its prose (tool calls, the
 * todo list) dropped first, as the chat does for a plain reply.
 */
export function Prose({ markdown }: ProseProps) {
  const Markdown = useContext(BriefMarkdownContext)
  const content = stripToolEchoes(markdown)
  if (content === "") return null
  // The brief's body size, not the chat's 16px reply size: the closing line
  // belongs to the brief above it.
  return (
    <div className="mt-3 text-[14px] leading-[22px] first:mt-0 [&_li]:text-[14px] [&_p]:text-[14px] [&_p]:leading-[22px]">
      <Markdown content={content} />
    </div>
  )
}

/**
 * `exposeComponent` re-derives each prop's schema type from the component's
 * props, and for a string union it builds the enum tuple in TypeScript's
 * internal union order, which need not match the order a definition lists
 * (`["info", "caution", "danger"]` against `["caution", "danger", "info"]`).
 * Each component's props type is inferred from its own definition in
 * `schema.ts`, so the two cannot disagree; widening the component skips the
 * re-derivation without loosening anything at runtime.
 */
function expose<P extends object>(
  component: ComponentType<P>,
  definition: BriefDefinition,
): ExposedComponent<ComponentType<object>> & BriefDefinition {
  return { ...exposeComponent(component as ComponentType<object>, definition), ...definition }
}

/** A definition from `schema.ts`: also what `createUiJsonSchema` accepts. */
interface BriefDefinition {
  readonly name: string
  readonly description: string
  readonly props: Record<string, s.HashbrownType>
}

/** The kit's components, exposed with the definitions the server's schema came from. */
export const briefComponents = [
  expose(BottomLine, bottomLineDefinition),
  expose(RouteSummary, routeSummaryDefinition),
  expose(WatchFor, watchForDefinition),
  expose(KeyNumbers, keyNumbersDefinition),
  expose(Assumptions, assumptionsDefinition),
  expose(Citations, citationsDefinition),
  expose(Prose, proseDefinition),
]
