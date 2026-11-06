export type DocsArea = "app" | "framework"

/** Identify the audience without matching similarly prefixed framework routes. */
export function docsArea(href: string): DocsArea | null {
  const path = (href.split(/[?#]/, 1)[0] ?? "").replace(/\/+$/, "")
  if (path === "/docs/app" || path.startsWith("/docs/app/")) return "app"
  return path.startsWith("/docs/") ? "framework" : null
}

export const DOCS_AREAS = [
  { id: "app", label: "App", href: "/docs/app" },
  { id: "framework", label: "Framework", href: "/docs/getting-started" },
] as const
