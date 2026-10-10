/**
 * The workbench's two buttons, at the two sizes they appear in. Both are
 * pills, per LiveLoveApp's rules.
 *
 * `neutralButton` is the quiet one: `RunError`'s Retry and Dismiss and
 * `MemoryPanel`'s decisions. `primaryButton` is the one action a surface
 * exists for, in ink: `ConnectScreen`'s "Try again".
 *
 * The scope stops there, deliberately. The rail's thread rows are not this
 * button at another size — they are a borderless list row with their own
 * hover and active states — so folding them in would mean a `variant`
 * argument that exists only to be branched on. `wb-focus` is what they
 * genuinely share, and that lives in `app/theme.css`.
 */
function scale(size: "sm" | "md"): string {
  // md is the app's 32px control height (`.wb-button`, the route bar, the rail's rows).
  return size === "sm" ? "px-3 py-1 text-[12px]" : "min-h-8 px-4 py-1 text-[13px]"
}

/** The quiet pill button's classes. */
export function neutralButton(size: "sm" | "md"): string {
  return `wb-focus rounded-full border border-wb-border bg-wb-surface font-medium tracking-tight transition-colors hover:border-wb-muted ${scale(size)}`
}

/** The ink pill button's classes, for the one action a surface exists for. */
export function primaryButton(size: "sm" | "md"): string {
  return `wb-focus rounded-full border border-wb-text bg-wb-text font-medium tracking-tight text-wb-surface transition-colors hover:bg-wb-muted hover:border-wb-muted ${scale(size)}`
}
