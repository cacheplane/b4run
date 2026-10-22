// Standalone source of truth for the events the site sends to PostHog.
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
  "command",
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
}
