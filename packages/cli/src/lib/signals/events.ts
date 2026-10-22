/**
 * Shapes the two anonymous usage signal events. This module is the privacy
 * boundary: the builders below are the only way an event is shaped, and
 * `toAllowedProperties` is the last filter before anything reaches the wire.
 */
import { CliError } from "../output.js"
import type { ReportingCommand } from "./env.js"

export const MAX_PROPERTY_LENGTH = 128

export type CommandOutcome = "ok" | "error" | "cancelled"
export type DurationBucket = "under_1s" | "1s_to_10s" | "10s_to_1m" | "1m_to_10m" | "over_10m"
export type RouteKind = "agent" | "chain" | "graph" | "workflow"

/** The only property names each event may carry. */
export const CLI_EVENT_PROPERTIES: Readonly<
  Record<"cli:command_completed" | "cli:dev_first_run_completed", readonly string[]>
> = {
  "cli:command_completed": [
    "command",
    "cli_version",
    "node_major",
    "os",
    "outcome",
    "duration_bucket",
    "error_class",
  ],
  "cli:dev_first_run_completed": ["cli_version", "route_kind"],
}

export interface SignalEvent {
  readonly event: keyof typeof CLI_EVENT_PROPERTIES
  readonly properties: Readonly<Record<string, string | number>>
}

export function durationBucket(ms: number): DurationBucket {
  if (ms < 1000) return "under_1s"
  if (ms < 10_000) return "1s_to_10s"
  if (ms < 60_000) return "10s_to_1m"
  if (ms < 600_000) return "1m_to_10m"
  return "over_10m"
}

/** Error names that are safe to report; any other class name could carry a project name. */
export const KNOWN_ERROR_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "CliError",
  "CommanderError",
])

/** A B4 code or a known error name; never the message. */
export function errorClass(error: unknown): string {
  if (error instanceof CliError && error.code !== undefined) return error.code
  if (error instanceof Error) {
    return KNOWN_ERROR_NAMES.has(error.name) ? error.name : "Error"
  }
  return "unknown"
}

export function capProperty(value: string): string {
  return value.slice(0, MAX_PROPERTY_LENGTH)
}

export function toAllowedProperties(
  event: SignalEvent["event"],
  properties: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string | number>> {
  const allowed = CLI_EVENT_PROPERTIES[event]
  const out: Record<string, string | number> = {}
  for (const key of allowed) {
    const value = properties[key]
    if (typeof value === "string") {
      out[key] = capProperty(value)
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value
    }
  }
  return out
}

export interface CommandCompletedInput {
  readonly command: ReportingCommand
  readonly cliVersion: string
  readonly nodeMajor: number
  readonly os: string
  readonly outcome: CommandOutcome
  readonly durationMs: number
  readonly error?: unknown
}

export function commandCompletedEvent(input: CommandCompletedInput): SignalEvent {
  const event = "cli:command_completed" as const
  return {
    event,
    properties: toAllowedProperties(event, {
      command: input.command,
      cli_version: input.cliVersion,
      node_major: input.nodeMajor,
      os: input.os,
      outcome: input.outcome,
      duration_bucket: durationBucket(input.durationMs),
      ...(input.outcome !== "ok" && input.error !== undefined
        ? { error_class: errorClass(input.error) }
        : {}),
    }),
  }
}

export function devFirstRunCompletedEvent(input: {
  readonly cliVersion: string
  readonly routeKind: RouteKind
}): SignalEvent {
  const event = "cli:dev_first_run_completed" as const
  return {
    event,
    properties: toAllowedProperties(event, {
      cli_version: input.cliVersion,
      route_kind: input.routeKind,
    }),
  }
}
