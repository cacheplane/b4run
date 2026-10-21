import type { PosthogClient } from "./client.js"
import { EVENT_CONTRACT, FORBIDDEN_PROPERTIES, MAX_LABEL_LENGTH } from "./contract.js"

export interface LiveEvent {
  event: string
  timestamp: string
  properties: Record<string, unknown>
}

export type QualityFindingKind =
  | "missing_required_property"
  | "forbidden_property"
  | "unexpected_property"
  | "label_too_long"
  | "insufficient_event_coverage"

export interface QualityFinding {
  severity: "error" | "warning"
  kind: QualityFindingKind
  event: string
  property: string
  timestamp: string
  message: string
}

export interface CoverageRequirement {
  event: string
  minCount: number
}

export const DEFAULT_COVERAGE: readonly CoverageRequirement[] = [
  { event: "$pageview", minCount: 1 },
]

// Properties PostHog or the browser add on its own; never reported as unexpected.
const INTERNAL_PROPERTY_NAMES = new Set([
  "_kx",
  "dclid",
  "distinct_id",
  "epik",
  "fbclid",
  "gad_source",
  "gbraid",
  "gclid",
  "gclsrc",
  "igshid",
  "irclid",
  "li_fat_id",
  "mc_cid",
  "msclkid",
  "qclid",
  "rdt_cid",
  "sccid",
  "ttclid",
  "twclid",
  "token",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
  "uuid",
  "wbraid",
])

const isMissing = (value: unknown): boolean => value === undefined || value === null || value === ""

const isInternal = (property: string): boolean =>
  property.startsWith("$") || INTERNAL_PROPERTY_NAMES.has(property)

export function evaluateEvents(
  events: readonly LiveEvent[],
  coverage: readonly CoverageRequirement[],
): QualityFinding[] {
  const forbidden = new Set<string>(FORBIDDEN_PROPERTIES)
  const findings: QualityFinding[] = []

  for (const item of events) {
    const contract = EVENT_CONTRACT[item.event]
    if (!contract) continue
    const allowed = new Set(contract.allowedProperties)

    for (const property of contract.requiredProperties) {
      if (isMissing(item.properties[property])) {
        findings.push({
          severity: "error",
          kind: "missing_required_property",
          event: item.event,
          property,
          timestamp: item.timestamp,
          message: `${item.event} is missing required property ${property}`,
        })
      }
    }

    for (const [property, value] of Object.entries(item.properties)) {
      if (forbidden.has(property)) {
        findings.push({
          severity: "error",
          kind: "forbidden_property",
          event: item.event,
          property,
          timestamp: item.timestamp,
          message: `${item.event} includes forbidden property ${property}`,
        })
        continue
      }
      if (!isInternal(property) && !allowed.has(property)) {
        findings.push({
          severity: "warning",
          kind: "unexpected_property",
          event: item.event,
          property,
          timestamp: item.timestamp,
          message: `${item.event} includes non-contract property ${property}`,
        })
      }
      if (typeof value === "string" && value.length > MAX_LABEL_LENGTH && allowed.has(property)) {
        findings.push({
          severity: "error",
          kind: "label_too_long",
          event: item.event,
          property,
          timestamp: item.timestamp,
          message: `${item.event} property ${property} is ${value.length} characters; the limit is ${MAX_LABEL_LENGTH}`,
        })
      }
    }
  }

  for (const requirement of coverage) {
    const count = events.filter((item) => item.event === requirement.event).length
    if (count < requirement.minCount) {
      findings.push({
        severity: "error",
        kind: "insufficient_event_coverage",
        event: requirement.event,
        property: "event_count",
        timestamp: "n/a",
        message: `${requirement.event} has ${count} recent ${count === 1 ? "event" : "events"}; expected at least ${requirement.minCount}`,
      })
    }
  }

  return findings
}

export async function fetchRecentEvents(
  client: PosthogClient,
  input: { eventNames: readonly string[]; after: string; limitPerEvent: number },
): Promise<LiveEvent[]> {
  const fetched: LiveEvent[] = []
  for (const event of input.eventNames) {
    const page = await client.get<{ results?: LiveEvent[] }>("events/", {
      event,
      after: input.after,
      limit: String(input.limitPerEvent),
    })
    fetched.push(...(page.results ?? []))
  }
  return fetched
}
