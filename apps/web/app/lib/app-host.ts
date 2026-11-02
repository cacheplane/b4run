/**
 * The three hosts the Agent Workspace apps use, one per build flavour. All three
 * point at this one Vercel project, so pages and the Apple association file
 * answer per host. Any other host (a preview deployment, localhost) is unknown.
 */
export type AppFlavour = "prod" | "beta" | "local"

const HOST_FLAVOURS: Readonly<Record<string, AppFlavour>> = {
  "b4.run": "prod",
  "www.b4.run": "prod",
  "test.b4.run": "beta",
  "local.b4.run": "local",
}

export function flavourForHost(host: string | null | undefined): AppFlavour | null {
  if (!host) return null
  const name = host.trim().toLowerCase().replace(/:\d+$/, "")
  return Object.hasOwn(HOST_FLAVOURS, name) ? (HOST_FLAVOURS[name] ?? null) : null
}

/** The host a request was addressed to, behind Vercel's proxy or not. */
export function hostFromHeaders(headers: Pick<Headers, "get">): string | null {
  const forwarded = headers.get("x-forwarded-host")?.split(",")[0]?.trim()
  return forwarded || headers.get("host")
}
