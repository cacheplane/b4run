import type { ReactElement, ReactNode } from "react"
import { type StepLabelOverrides, stepLabel } from "../../view/labels.js"
import type { ToolStep } from "../../view/turns.js"
import { Disclosure, useDisclosure } from "./Disclosure.js"
import { StepIcon } from "./icons.js"
import { SourceChips } from "./SourceChips.js"
import { StatusText } from "./StatusText.js"
import { StepDetail } from "./StepDetail.js"
import { useLive } from "./useLive.js"

/** An app view that replaces a step's `StepDetail` (spec §3.1 "Per-tool views"). */
export type StepRenderer = (props: { readonly step: ToolStep }) => ReactNode
export type StepRenderers = Readonly<Record<string, StepRenderer>>

export interface StepProps {
  readonly step: ToolStep
  readonly labels?: StepLabelOverrides | undefined
  readonly renderStep?: StepRenderers | undefined
  readonly now: () => number
}

/** The muted tail: awaiting approval, denied, or failed with no error text to open. */
function meta(step: ToolStep): string {
  if (step.status === "awaiting") return "· awaiting approval"
  if (step.status === "denied") return "· denied"
  if (step.status === "failed" && step.result === undefined) return "· failed"
  return ""
}

/** Own-key lookup: tool names come off the wire, so `toString` must not find `Object.prototype`. */
function customRenderer(
  renderers: StepRenderers | undefined,
  name: string,
): StepRenderer | undefined {
  return renderers !== undefined && Object.hasOwn(renderers, name) ? renderers[name] : undefined
}

/** One tool call as a sentence; opens to its inputs and output (spec §3 `Step`). */
export function Step({ step, labels, renderStep, now }: StepProps): ReactElement {
  const live = useLive(step, now)
  const state = step.status === "running" && !live ? "pending" : step.status
  const failed = step.status === "failed"
  // Keyed by `startedAt`: the same call going awaiting → running keeps what
  // the user opened; a re-presented call hands control back to automation.
  const { open, toggle } = useDisclosure(failed, live, step.startedAt)
  const custom = customRenderer(renderStep, step.name)
  return (
    <li
      className="b4-step"
      data-state={state}
      data-kind="tool"
      {...(open ? { "data-expanded": "true" } : {})}
    >
      <Disclosure
        className="b4-step__line"
        open={open}
        onToggle={toggle}
        summary={
          <>
            <StepIcon name={failed ? "alert" : step.icon} />
            <span className="b4-step__text">{stepLabel(step, labels)}</span>
            <StatusText>{meta(step)}</StatusText>
          </>
        }
      >
        {custom ? (
          <div className="b4-step__detail">{custom({ step })}</div>
        ) : (
          <StepDetail args={step.args} result={step.result} />
        )}
      </Disclosure>
      {step.sources ? <SourceChips sources={step.sources} /> : null}
    </li>
  )
}
