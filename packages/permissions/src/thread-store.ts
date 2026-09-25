import { matchPermission } from "./pattern-matching.js"
import type { PermissionsStore } from "./types.js"

type PatternMap = Readonly<Record<string, readonly string[]>>

/** One thread's own lists, in the vocabulary of `permissions.allow` and `permissions.deny`. */
export interface ThreadPermissions {
  readonly allow?: PatternMap
  readonly deny?: PatternMap
}

/** Where a thread's "Always" grants live: the thread's own record, never `.b4/permissions.json`. */
export interface ThreadPermissionGrants {
  list(): PatternMap
  add(tool: string, pattern: string): void | Promise<void>
}

/**
 * Merge pattern maps per tool into a fresh map without a prototype, so a tool
 * named like an `Object.prototype` member (`constructor`, `__proto__`) is an
 * ordinary key that matches nothing unless it was listed.
 */
function concat(...maps: readonly PatternMap[]): Record<string, string[]> {
  const out: Record<string, string[]> = Object.create(null)
  for (const map of maps) {
    for (const [tool, list] of Object.entries(map)) out[tool] = [...(out[tool] ?? []), ...list]
  }
  return out
}

/**
 * The store one thread's permission gates consult when its sandbox was
 * resolved with its own permissions. The mode is the app's. A candidate is
 * denied when the thread's `deny` or the app's store denies it; otherwise
 * allowed when the thread's `allow`, or in interactive mode a grant the thread
 * recorded, matches; otherwise unknown. The app's allow-lists (config and
 * runtime) are not consulted: another thread's "Always" must not reach this
 * one. `addAllow` writes to the thread's grants only.
 */
export function createThreadPermissionsStore(options: {
  readonly base: PermissionsStore
  readonly permissions: ThreadPermissions
  readonly grants: ThreadPermissionGrants
}): PermissionsStore {
  const { base, permissions, grants } = options
  const allow = concat(permissions.allow ?? {})
  const deny = concat(permissions.deny ?? {})
  const none = concat()
  let granted: Record<string, string[]> = concat()
  return {
    mode: base.mode,
    async load() {
      granted = concat(grants.list())
    },
    match(tool, candidate) {
      if (base.mode === "bypass") return "unknown"
      if (matchPermission(tool, candidate, none, deny) === "deny") return "deny"
      if (base.match(tool, candidate) === "deny") return "deny"
      return matchPermission(
        tool,
        candidate,
        base.mode === "interactive" ? concat(allow, granted) : allow,
        none,
      )
    },
    async addAllow(tool, pattern) {
      await grants.add(tool, pattern)
      granted = concat(granted, { [tool]: [pattern] })
    },
  }
}
