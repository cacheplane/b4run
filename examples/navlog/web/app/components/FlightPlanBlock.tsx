"use client"
import { useState } from "react"
import type { FlightPlan } from "../lib/navlog-types"

const ITEMS: readonly { readonly key: keyof FlightPlan; readonly label: string }[] = [
  { key: "item7", label: "7 Aircraft ID" },
  { key: "item8", label: "8 Rules / type" },
  { key: "item9", label: "9 Type / wake" },
  { key: "item10", label: "10 Equipment" },
  { key: "item13", label: "13 Departure" },
  { key: "item15", label: "15 Speed / level / route" },
  { key: "item16", label: "16 Destination / EET" },
  { key: "item18", label: "18 Other" },
  { key: "item19", label: "19 Endurance / POB" },
]

/** The FPL message a filing service accepts, one item per line. */
export function fplMessage(plan: FlightPlan): string {
  return [
    `(FPL-${plan.item7}-${plan.item8}`,
    `-${plan.item9}-${plan.item10}`,
    `-${plan.item13}`,
    `-${plan.item15}`,
    `-${plan.item16}`,
    `-${plan.item18}`,
    `-${plan.item19})`,
  ].join("\n")
}

/**
 * Copies the FPL message to the clipboard. Shared by the flight plan block and
 * the navlog sheet's action bar so the two buttons behave identically.
 */
export function CopyFplButton({
  plan,
  className = "",
}: {
  readonly plan: FlightPlan
  readonly className?: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={`wb-focus rounded-wb-sm border border-wb-border px-2.5 py-1 text-[12px] ${className}`}
      onClick={() => {
        void navigator.clipboard?.writeText(fplMessage(plan)).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? "Copied" : "Copy FPL"}
    </button>
  )
}

/** ICAO flight plan items 7 to 19 laid out as the form, with a copy button. */
export function FlightPlanBlock({ plan }: { readonly plan: FlightPlan }) {
  return (
    <section aria-label="Flight plan" className="mt-3">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2 text-[12px]">
        {ITEMS.map((item) => (
          <div key={item.key} className="rounded-wb-sm bg-wb-rail px-2 py-1.5">
            <span className="block text-[11px] text-wb-muted">{item.label}</span>
            <span className="font-medium tabular-nums">{plan[item.key]}</span>
          </div>
        ))}
      </div>
      <CopyFplButton plan={plan} className="mt-2" />
    </section>
  )
}
