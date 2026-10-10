import { stripToolEchoes } from "../lib/assistant-text"
import { isStructuredAnswer } from "./parse"
import type {
  AssumptionOrigin,
  AssumptionsProps,
  BottomLineProps,
  Citation,
  KeyNumbersProps,
  ProseProps,
  RouteSummaryProps,
  WatchForProps,
  WatchSeverity,
} from "./schema"

/**
 * A structured answer as plain text, for the chat's Copy: the JSON the model
 * wrote is no use pasted into a note or a message, so each component becomes
 * readable lines, in the answer's order, with its citations as `[n]` markers
 * that number the Sources list.
 */

const SEVERITY: Record<WatchSeverity, string> = {
  info: "Info",
  caution: "Caution",
  danger: "Danger",
}

const ORIGIN: Record<AssumptionOrigin, string> = {
  pilot: "You said",
  memory: "From memory",
  default: "Default",
}

type Node = Readonly<Record<string, { readonly props?: unknown } | undefined>>

const items = <T>(props: unknown): readonly T[] => {
  const list = (props as { items?: unknown } | undefined)?.items
  return Array.isArray(list) ? (list as T[]) : []
}

/**
 * The answer's components as plain-text paragraphs, blank-line separated.
 * Null for markdown, a partial answer, or JSON that is not `{ "ui": [...] }`.
 */
export function briefPlainText(answer: string): string | null {
  if (!isStructuredAnswer(answer)) return null
  let ui: unknown
  try {
    ui = (JSON.parse(answer) as { ui?: unknown } | null)?.ui
  } catch {
    return null
  }
  if (!Array.isArray(ui)) return null
  const nodes = ui as Node[]
  const citations = nodes.flatMap((node) => items<Citation>(node?.Citations?.props))
  const marks = (ids: unknown): string => {
    if (!Array.isArray(ids)) return ""
    const numbers = ids
      .map((id) => citations.findIndex((item) => item.id === id) + 1)
      .filter((n) => n > 0)
    return numbers.map((n) => ` [${n}]`).join("")
  }
  const paragraphs: string[] = []
  for (const node of nodes) {
    const [name, entry] = Object.entries(node ?? {})[0] ?? []
    const props = entry?.props
    if (name === undefined || props === undefined || props === null) continue
    switch (name) {
      case "BottomLine": {
        const { level, reason, cite } = props as BottomLineProps
        paragraphs.push(`Bottom line: ${level}. ${reason}${marks(cite)}`)
        break
      }
      case "RouteSummary": {
        const { from, to, via, altitudeFt, departureUtc } = props as RouteSummaryProps
        const stops = [from, ...(Array.isArray(via) ? via : []), to].join(" → ")
        const altitude = typeof altitudeFt === "number" ? altitudeFt.toLocaleString("en-US") : ""
        paragraphs.push(`Route: ${stops} at ${altitude} ft, departing ${departureUtc}`)
        break
      }
      case "WatchFor": {
        const list = items<WatchForProps["items"][number]>(props)
        paragraphs.push(
          list.length === 0
            ? "Watch for: nothing during the flight"
            : [
                "Watch for:",
                ...list.map(
                  (item) =>
                    `- ${SEVERITY[item.severity] ?? item.severity}: ${item.what}${
                      item.when ? ` (${item.when})` : ""
                    }${marks(item.cite)}`,
                ),
              ].join("\n"),
        )
        break
      }
      case "KeyNumbers": {
        const list = items<KeyNumbersProps["items"][number]>(props)
        if (list.length === 0) break
        paragraphs.push(
          [
            "Key numbers:",
            ...list.map(
              (item) =>
                `- ${item.label}: ${item.value}${item.unit ? ` ${item.unit}` : ""}${marks(item.cite)}`,
            ),
          ].join("\n"),
        )
        break
      }
      case "Assumptions": {
        const list = items<AssumptionsProps["items"][number]>(props)
        if (list.length === 0) break
        paragraphs.push(
          [
            "Assumptions:",
            ...list.map((item) => `- ${item.statement} (${ORIGIN[item.origin] ?? item.origin})`),
          ].join("\n"),
        )
        break
      }
      case "Citations": {
        if (citations.length === 0) break
        paragraphs.push(
          [
            "Sources:",
            ...citations.map(
              (item, i) => `${i + 1}. ${item.source}${item.locator ? `, ${item.locator}` : ""}`,
            ),
          ].join("\n"),
        )
        break
      }
      case "Prose": {
        const text = stripToolEchoes(String((props as ProseProps).markdown ?? ""))
        if (text !== "") paragraphs.push(text)
        break
      }
    }
  }
  return paragraphs.join("\n\n")
}
