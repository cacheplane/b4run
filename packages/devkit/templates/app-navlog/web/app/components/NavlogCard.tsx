"use client"
import { useRenderTool } from "@copilotkit/react-core/v2"
import { formatGal } from "../lib/format"
import { parseNavlog } from "../lib/navlog-selectors"
import type { ToolCallStatus } from "./ToolCallCard"

export interface NavlogCardViewProps {
  readonly status: ToolCallStatus
  readonly parameters: unknown
  readonly result?: string | undefined
}

/** The compact in-transcript card for a computeNavlog call; the sheet and the map show the full result. */
export function NavlogCardView({ status, result }: NavlogCardViewProps) {
  const navlog = status === "complete" && result !== undefined ? parseNavlog(result) : null
  return (
    <div className="rounded-wb border border-wb-border bg-wb-surface px-3 py-2 text-[13px]">
      <span className="font-mono text-[12px] text-wb-muted">computeNavlog</span>
      {status !== "complete" ? (
        <p className="mt-0.5 motion-safe:animate-pulse">Computing the navlog…</p>
      ) : navlog ? (
        <p className="mt-0.5 tabular-nums">
          {navlog.totals.distanceNm} nm · {navlog.legs.length} legs ·{" "}
          {formatGal(navlog.totals.fuelGal)} gal. See the navlog sheet and the map.
        </p>
      ) : null}
    </div>
  )
}

/**
 * CopilotKit 1.76's name-scoped `useRenderTool` overload requires a Standard
 * Schema for `parameters`. The card never reads them (the result carries the
 * navlog) and CopilotKit only stores the schema, so this one accepts any value
 * as-is rather than pulling in a schema library for a type.
 */
const ANY_PARAMETERS = {
  "~standard": {
    version: 1,
    vendor: "navlog-web",
    validate: (value: unknown) => ({ value }),
  },
} as const

/** Registration-only, like ToolCallCard: a name-specific renderer wins over the wildcard. */
export function NavlogCard() {
  useRenderTool(
    {
      name: "computeNavlog",
      parameters: ANY_PARAMETERS,
      render: ({ status, parameters, result }) => (
        <NavlogCardView
          status={status}
          parameters={parameters}
          {...(result !== undefined ? { result } : {})}
        />
      ),
    },
    [],
  )
  return null
}
