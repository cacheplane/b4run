// Standalone source of truth for the events the site and the CLI send to PostHog.
// contract.test.ts pins this to SIGNAL_EVENTS in apps/web; do not import from apps/web here.

export const FORBIDDEN_PROPERTIES = [
  "email",
  "path",
  "prompt",
  "messages",
  "error",
  "threadId",
  "runId",
  "query",
  "text",
] as const

export interface EventContract {
  readonly requiredProperties: readonly string[]
  readonly allowedProperties: readonly string[]
  readonly allowedBreakdowns: readonly string[]
}

export const MAX_LABEL_LENGTH = 128

export const EVENT_CONTRACT: Readonly<Record<string, EventContract>> = {
  $pageview: {
    requiredProperties: [],
    allowedProperties: ["$pathname", "title"],
    allowedBreakdowns: ["$pathname"],
  },
  "site:cta_click": {
    requiredProperties: ["cta_id", "surface"],
    allowedProperties: ["cta_id", "surface", "destination_url", "source_page"],
    allowedBreakdowns: ["cta_id", "surface", "source_page"],
  },
  "site:external_link_click": {
    requiredProperties: ["destination_host", "surface"],
    allowedProperties: ["destination_host", "surface", "source_page"],
    allowedBreakdowns: ["destination_host", "surface"],
  },
  "site:install_command_copied": {
    requiredProperties: ["surface"],
    allowedProperties: ["surface", "source_page"],
    allowedBreakdowns: ["surface"],
  },
  "site:engaged_time": {
    requiredProperties: ["engaged_seconds"],
    allowedProperties: ["engaged_seconds", "source_page"],
    allowedBreakdowns: ["engaged_seconds", "source_page"],
  },
  "docs:search_open": {
    requiredProperties: ["source_page"],
    allowedProperties: ["source_page"],
    allowedBreakdowns: ["source_page"],
  },
  "docs:search_result_click": {
    requiredProperties: ["source_page"],
    allowedProperties: ["source_page"],
    allowedBreakdowns: ["source_page"],
  },
  "docs:copy_code_click": {
    requiredProperties: ["source_page"],
    allowedProperties: ["source_page", "code_lang"],
    allowedBreakdowns: ["code_lang", "source_page"],
  },
  "blog:copy_code_click": {
    requiredProperties: ["source_page"],
    allowedProperties: ["source_page", "code_lang"],
    allowedBreakdowns: ["code_lang", "source_page"],
  },
  "site:form_submit": {
    requiredProperties: ["form"],
    allowedProperties: ["form", "failure_reason", "source_page"],
    allowedBreakdowns: ["form", "failure_reason"],
  },
  "site:form_success": {
    requiredProperties: ["form"],
    allowedProperties: ["form", "failure_reason", "source_page"],
    allowedBreakdowns: ["form", "failure_reason"],
  },
  "site:form_fail": {
    requiredProperties: ["form"],
    allowedProperties: ["form", "failure_reason", "source_page"],
    allowedBreakdowns: ["form", "failure_reason"],
  },
  "site:contact_accepted": {
    requiredProperties: ["form", "email_kind"],
    allowedProperties: ["form", "email_kind", "failure_reason", "source_page"],
    allowedBreakdowns: ["form", "email_kind"],
  },
  "cli:command_completed": {
    requiredProperties: [
      "command",
      "cli_version",
      "node_major",
      "os",
      "outcome",
      "duration_bucket",
    ],
    allowedProperties: [
      "command",
      "cli_version",
      "node_major",
      "os",
      "outcome",
      "duration_bucket",
      "error_class",
    ],
    allowedBreakdowns: [
      "command",
      "outcome",
      "os",
      "node_major",
      "cli_version",
      "duration_bucket",
      "error_class",
    ],
  },
  "cli:dev_first_run_completed": {
    requiredProperties: ["cli_version", "route_kind"],
    allowedProperties: ["cli_version", "route_kind"],
    allowedBreakdowns: ["cli_version", "route_kind"],
  },
}
