export const SIGNAL_EVENTS = {
  siteCtaClick: "site:cta_click",
  siteExternalLinkClick: "site:external_link_click",
  siteInstallCommandCopied: "site:install_command_copied",
  siteEngagedTime: "site:engaged_time",
  docsSearchOpen: "docs:search_open",
  docsSearchResultClick: "docs:search_result_click",
  docsCopyCodeClick: "docs:copy_code_click",
  blogCopyCodeClick: "blog:copy_code_click",
  siteFormSubmit: "site:form_submit",
  siteFormSuccess: "site:form_success",
  siteFormFail: "site:form_fail",
  siteContactAccepted: "site:contact_accepted",
} as const

export type SignalEventName = (typeof SIGNAL_EVENTS)[keyof typeof SIGNAL_EVENTS]

export const SIGNAL_SURFACES = ["header", "mobile_nav", "footer", "home", "docs", "blog"] as const

export type SignalSurface = (typeof SIGNAL_SURFACES)[number]

export const CTA_IDS = [
  "header_get_started",
  "header_blog",
  "header_live_demo",
  "header_github",
  "footer_github",
  "footer_npm",
  "footer_live_demo",
  "footer_rss",
  "footer_updates",
  "home_scaffold",
  "home_get_started",
  "home_github",
  "home_live_demo",
  "blog_cta_get_started",
  "blog_cta_updates",
  "docs_prompt_copy",
] as const

export type CtaId = (typeof CTA_IDS)[number]

export interface SignalProperties {
  readonly cta_id?: CtaId
  readonly surface?: SignalSurface
  readonly destination_url?: string
  readonly destination_host?: string
  readonly engaged_seconds?: 10 | 30
  readonly code_lang?: string
  readonly source_page?: string
  readonly form?: "founder_updates"
  readonly failure_reason?: string
  readonly email_kind?: "work" | "personal"
}
