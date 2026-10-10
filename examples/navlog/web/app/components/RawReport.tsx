import { reportView } from "../lib/weather-selectors"

/**
 * One raw report under its label, as the Weather tab's cards and the map's
 * marker panel both show it: the report in mono, or a muted line when the
 * station issues none or the brief has none.
 */
export function RawReport({
  label,
  text,
}: {
  readonly label: "METAR" | "TAF"
  readonly text: string
}) {
  const view = reportView(text, label)
  return (
    <div className="mt-2">
      <p className="text-[11px] font-semibold text-wb-muted">{label}</p>
      {view.kind === "report" ? (
        <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-snug text-wb-text">
          {view.body}
        </pre>
      ) : (
        <p className="text-[12.5px] text-wb-muted">
          {view.kind === "none" ? `No ${label} issued` : `No ${label} in the brief`}
        </p>
      )}
    </div>
  )
}
