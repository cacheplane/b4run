/**
 * One raw report under its label, as the Weather tab's cards and the map's
 * marker panel both show it: the report in mono, or a muted line when the
 * airport has none ("No METAR", "No TAF issued"). A report that repeats its
 * label's word ("TAF KBDN …" under "TAF") drops it; a SPECI keeps its word,
 * because the label alone would hide that it is a special observation.
 */
export function RawReport({
  label,
  raw,
}: {
  readonly label: "METAR" | "TAF"
  readonly raw: string | null
}) {
  const body = raw?.trim().replace(new RegExp(`^${label}\\s+`), "") ?? ""
  return (
    <div className="mt-2">
      <p className="text-[11px] font-semibold text-wb-muted">{label}</p>
      {body !== "" ? (
        <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-snug text-wb-text">
          {body}
        </pre>
      ) : (
        <p className="text-[12.5px] text-wb-muted">
          {label === "METAR" ? "No METAR" : "No TAF issued"}
        </p>
      )}
    </div>
  )
}
