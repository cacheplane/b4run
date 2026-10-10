import { Fragment } from "react"
import {
  inlineSegments,
  parsePlanningAnswer,
  stripToolEchoes,
  textBlocks,
} from "../lib/assistant-text"
import { type EffectiveVerdict, isWorse, outrankNote } from "../lib/verdict"
import { VerdictPill } from "./VerdictCard"

/** One line of answer text, with its `**bold**` runs as `<strong>`. */
function Inline({ text }: { readonly text: string }) {
  return (
    <>
      {inlineSegments(text).map((segment, i) =>
        segment.bold ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one immutable string
          <strong key={i} className="font-semibold">
            {segment.text}
          </strong>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one immutable string
          <Fragment key={i}>{segment.text}</Fragment>
        ),
      )}
    </>
  )
}

export interface PlanningBriefProps {
  /** The planning answer of the turn that produced the navlog, as markdown. */
  readonly planningAnswer: string
  /**
   * The verdict the card above shows (`resolveVerdict`). When it is worse
   * than the planner's bottom line, the bottom line shows its level instead,
   * with the planner's own level noted, so the two never disagree.
   */
  readonly verdict?: EffectiveVerdict | null | undefined
}

/**
 * The FALLBACK planning brief: a markdown planning answer, which only a
 * thread from before the structured brief kit holds. A structured answer
 * renders with `BriefRenderer` instead (see `NavlogSheet`). The
 * labelled answer ("Bottom line:", "Watch for:", "Numbers:", "Assumptions:") renders as its
 * sections with the bottom line first and loudest; an older free-text answer
 * renders as formatted prose. Tool-call echoes and the plan checklist a model
 * sometimes repeats are stripped either way.
 *
 * The answer's closing (the question offering next steps) renders after the
 * sections as a plain line, on screen only: it is the chat's question, so the
 * printed navlog leaves it out.
 */
export function PlanningBrief({ planningAnswer, verdict = null }: PlanningBriefProps) {
  const clean = stripToolEchoes(planningAnswer)
  if (clean === "") return null
  const answer = parsePlanningAnswer(clean)
  const planner = answer?.verdict ?? null
  const outranked =
    planner !== null && verdict !== null && isWorse(verdict.level, planner.level) ? verdict : null
  return (
    <section aria-label="Planning brief" className="wb-brief mt-4">
      <h3 className="wb-eyebrow">Planning brief</h3>
      {answer ? (
        <>
          {outranked !== null && planner !== null ? (
            <p className="wb-bottom-line mt-1.5">
              <span className="wb-eyebrow mr-1.5 inline">Bottom line</span>
              <span className="mr-1.5 inline-flex align-middle">
                <VerdictPill verdict={{ level: outranked.level, reason: "" }} />
              </span>
              <Inline text={planner.reason} />
              <span className="wb-bottom-line-note">{outrankNote(planner.level, outranked)}</span>
            </p>
          ) : (
            <p className="wb-bottom-line mt-1.5">
              <span className="wb-eyebrow mr-1.5 inline">Bottom line</span>
              <Inline text={answer.bottomLine} />
            </p>
          )}
          <div className="mt-2 grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]">
            {answer.sections.map((section) => (
              <div key={section.title}>
                <h4 className="text-[12px] font-semibold text-wb-text">{section.title}</h4>
                <ul className="mt-1 grid gap-1 text-[13px] leading-snug">
                  {section.items.map((item) => (
                    <li key={item} className="wb-brief-item">
                      <Inline text={item} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {answer.closing !== undefined ? (
            <p className="wb-brief-closing mt-3 text-[13px] leading-snug text-wb-muted print:hidden">
              <Inline text={answer.closing} />
            </p>
          ) : null}
        </>
      ) : (
        <div className="mt-1.5 grid gap-2 text-[13px] leading-relaxed">
          {textBlocks(clean).map((block, i) => {
            const key = `${block.kind}-${i}`
            if (block.kind === "heading") {
              return (
                <h4 key={key} className="mt-1 text-[12.5px] font-semibold">
                  <Inline text={block.text} />
                </h4>
              )
            }
            if (block.kind === "list") {
              const List = block.ordered ? "ol" : "ul"
              return (
                <List
                  key={key}
                  className={`grid gap-0.5 pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`}
                >
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
      )}
    </section>
  )
}
