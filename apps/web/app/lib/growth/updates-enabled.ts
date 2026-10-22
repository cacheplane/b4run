/**
 * Whether the /updates form and the links to it ship. Read once at module load
 * so the static pages inline it at build; presence only, no validation. This
 * module must stay free of server-only imports because the footer and blog
 * call to action render at build.
 */
/** Read at build; `apps/web/turbo.json` must declare each one or the build never sees it. */
export const UPDATES_FORM_REQUIRED_ENV = [
  "GROWTH_DATABASE_URL",
  "GROWTH_EMAIL_HMAC_SECRET",
  "GROWTH_TOKEN_SECRET",
  "GROWTH_ENVIRONMENT",
] as const

export const UPDATES_FORM_ENABLED: boolean = UPDATES_FORM_REQUIRED_ENV.every(
  (name) => (process.env[name] ?? "").trim() !== "",
)
