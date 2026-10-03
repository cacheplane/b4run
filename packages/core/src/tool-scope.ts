import type { ToolScope } from "@b4run/sdk"

export type ToolOrigin = "authored" | "capability"

/**
 * Capability-contributed tools are tagged with a synthetic filePath
 * `<capability:NAME>` at composition (see execute-route.ts). Everything else
 * is authored from the route's tools/*.ts.
 */
export function toolOrigin(tool: { readonly filePath: string }): ToolOrigin {
  return tool.filePath.startsWith("<capability:") ? "capability" : "authored"
}

export interface ScopeInput {
  readonly name: string
  readonly origin: ToolOrigin
}

/**
 * Resolve which tool names survive a route's scope.
 *
 * Base set: top route → all tools; subagent → authored only (capability
 * tools withheld). Then `allow` GRANTS named tools into the set, `deny`
 * REVOKES named tools, and deny wins. Unknown names in allow/deny/approve
 * (absent from the full available set) throw so authoring typos fail loud at
 * composition time.
 *
 * Implied denials: some tools can do what another tool does. `editFile`
 * writes files just as `writeFile` does, so a scope that denies `writeFile`
 * also withholds `editFile` — otherwise a route that denied writes before
 * `editFile` existed would silently regain them. Naming the implied tool in
 * `allow` opts back in (`deny: ["writeFile"], allow: ["editFile"]` edits
 * existing files but cannot create new ones). The reverse never holds: an
 * allow-list naming `writeFile` does NOT grant `editFile`; allow-lists stay
 * explicit.
 */
/** `deny` of the key also withholds each listed tool, unless `allow` names it. */
const IMPLIED_TOOL_DENIALS: Readonly<Record<string, readonly string[]>> = {
  writeFile: ["editFile"],
}

/** Tools withheld only because `deny` names a tool that implies them. */
export function impliedToolDenials(
  scope:
    | {
        readonly allow?: readonly string[] | undefined
        readonly deny?: readonly string[] | undefined
      }
    | undefined,
): readonly string[] {
  const allow = new Set(scope?.allow ?? [])
  const deny = new Set(scope?.deny ?? [])
  const implied: string[] = []
  for (const denied of deny) {
    for (const name of IMPLIED_TOOL_DENIALS[denied] ?? []) {
      if (!deny.has(name) && !allow.has(name) && !implied.includes(name)) implied.push(name)
    }
  }
  return implied
}

export function resolveToolScope(
  tools: readonly ScopeInput[],
  scope: ToolScope | undefined,
  context: { readonly isSubagent: boolean; readonly routeId: string },
): ReadonlySet<string> {
  const available = new Set(tools.map((t) => t.name))
  const unknown = [
    ...(scope?.allow ?? []),
    ...(scope?.deny ?? []),
    ...(scope?.approve ?? []),
  ].filter((n) => !available.has(n))
  if (unknown.length > 0) {
    throw new Error(
      `Route "${context.routeId}" tool scope references unknown tool(s): ${unknown.join(", ")}. ` +
        `Available: ${[...available].sort().join(", ")}.`,
    )
  }

  const allow = new Set(scope?.allow ?? [])
  const deny = new Set(scope?.deny ?? [])

  const keep = new Set<string>()
  for (const t of tools) {
    const inBase = context.isSubagent ? t.origin === "authored" : true
    if (inBase || allow.has(t.name)) keep.add(t.name)
  }
  for (const name of deny) keep.delete(name)
  for (const name of impliedToolDenials(scope)) keep.delete(name)
  return keep
}
