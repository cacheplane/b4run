/**
 * The workbench's neutral button, at the two sizes it appears in.
 *
 * Shared because `RunError`'s Retry and Dismiss, `MemoryPanel`'s decisions and
 * `ConnectScreen`'s retry are the same control at two scales, and they had
 * drifted into byte-for-byte identical copies that a reader could not tell
 * were meant to match.
 *
 * The scope stops there, deliberately. The rail's thread rows are not this
 * button at another size — they are a borderless list row with their own
 * hover and active states — so folding them in would mean a `variant`
 * argument that exists only to be branched on. `wb-focus` is what they
 * genuinely share, and that lives in `app/theme.css`.
 */
export function neutralButton(size: "sm" | "md"): string {
  const scale = size === "sm" ? "px-2.5 py-1 text-[12px]" : "px-3.5 py-1.5 text-[13px]"
  return `wb-focus rounded-wb-sm border border-wb-border bg-wb-surface font-medium tracking-tight transition-colors hover:border-wb-muted ${scale}`
}
