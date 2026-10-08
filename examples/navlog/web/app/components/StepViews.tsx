"use client"
import { StepDetail, type StepRenderers } from "@b4run/ag-ui/react"
import type { StepLabelOverrides, ToolStep } from "@b4run/ag-ui/view"
import { useContext } from "react"
import { formatGal } from "../lib/format"
import { parseNavlog } from "../lib/navlog-selectors"
import { MediaParts } from "./MediaParts"
import { SheetControlContext } from "./sheet-control"

/**
 * A computeNavlog step, opened: the totals in one line and a way to the sheet,
 * which (with the map) shows the full result. Anything that is not a parsed
 * navlog yet (still running, failed, a result that does not parse) keeps the
 * kit's step detail.
 */
export function NavlogStepView({ step }: { readonly step: ToolStep }) {
  const navlog =
    step.status === "done" && step.result !== undefined ? parseNavlog(step.result) : null
  const { openSheet } = useContext(SheetControlContext)
  if (navlog === null) return <StepDetail args={step.args} result={step.result} />
  const legs = navlog.legs.length
  return (
    <p className="tabular-nums">
      {navlog.totals.distanceNm} nm · {legs} leg{legs === 1 ? "" : "s"} ·{" "}
      {formatGal(navlog.totals.fuelGal)} gal{" "}
      <button type="button" className="wb-focus underline" onClick={openSheet}>
        See the navlog sheet
      </button>
    </p>
  )
}

/**
 * A renderChart step, opened: the image the tool returned. The step carries a
 * result's media as `parts`, live and after a restore; with none (a failed
 * call, or a result that held only text) it keeps the kit's detail.
 */
export function ChartStepView({ step }: { readonly step: ToolStep }) {
  if (step.parts !== undefined && step.parts.length > 0) return <MediaParts parts={step.parts} />
  return <StepDetail args={step.args} result={step.result} />
}

/** `B4Activity`'s `renderStep`: per-tool views inside the kit's `Step`. */
export const NAVLOG_STEP_RENDERERS: StepRenderers = {
  computeNavlog: ({ step }) => <NavlogStepView step={step} />,
  renderChart: ({ step }) => <ChartStepView step={step} />,
}

/**
 * `B4Activity`'s `labels`: how a run of one tool reads once merged. The kit
 * phrases a run whose labels differ only in a short name ("Looked up KSTP" and
 * "Looked up KRST (…)" read "Looked up KSTP and KRST"), so `lookupAirport`
 * needs no entry; these tools' labels carry lists or numbers, and without an
 * entry the merged row would fall back to the tool's name ("Used getMetar 2
 * times").
 */
export const NAVLOG_STEP_LABELS: StepLabelOverrides = {
  getMetar: { group: (n) => `Fetched METARs ${n} times` },
  getTaf: { group: (n) => `Fetched TAFs ${n} times` },
  getWindsAloft: { group: (n) => `Checked winds aloft ${n} times` },
  getAdvisories: { group: (n) => `Checked advisories ${n} times` },
  readDoc: { group: (n) => `Read ${n} documents` },
}
