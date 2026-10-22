/**
 * Whether the /updates form and the links to it ship. Read once at module load
 * so the static pages inline it at build; presence only, no validation. This
 * module must stay free of server-only imports because the footer and blog
 * call to action render at build.
 */
const REQUIRED = [
  "GROWTH_DATABASE_URL",
  "GROWTH_EMAIL_HMAC_SECRET",
  "GROWTH_TOKEN_SECRET",
  "GROWTH_ENVIRONMENT",
] as const

export const UPDATES_FORM_ENABLED: boolean = REQUIRED.every(
  (name) => (process.env[name] ?? "").trim() !== "",
)
