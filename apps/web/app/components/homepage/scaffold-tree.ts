import "server-only"
import data from "./scaffold-tree.json"

export interface ScaffoldEntry {
  readonly label: string
  /** Relative to the basic template's root; the test checks it ships. */
  readonly path: string
  readonly note: string
  readonly href?: string
  readonly children?: readonly ScaffoldEntry[]
}

export interface ScaffoldTree {
  readonly command: string
  /** Printed after "✔ ", exactly as create-b4-app prints it. */
  readonly created: string
  readonly root: string
  readonly entries: readonly ScaffoldEntry[]
  readonly next: string
}

export interface TreeRow {
  readonly label: string
  readonly note: string
  readonly href?: string
  /** Box-drawing prefix, e.g. "│  ├─ ". */
  readonly glyph: string
  /** Position in the terminal's reveal sequence. */
  readonly order: number
  readonly children: readonly TreeRow[]
}

/** What `npm create b4-app@latest my-agent` scaffolds, as the homepage hero shows it. */
export const scaffoldTree: ScaffoldTree = data

/**
 * Lays entries out as terminal rows: box-drawing glyphs, and a reveal order
 * that continues from `start` (the lines above the tree take 0…start-1).
 * Returns the order after the last row.
 */
export function layoutTree(
  entries: readonly ScaffoldEntry[],
  start: number,
): { readonly rows: readonly TreeRow[]; readonly next: number } {
  let order = start
  const walk = (list: readonly ScaffoldEntry[], prefix: string): TreeRow[] =>
    list.map((entry, index) => {
      const last = index === list.length - 1
      const own = order++
      return {
        label: entry.label,
        note: entry.note,
        ...(entry.href !== undefined ? { href: entry.href } : {}),
        glyph: `${prefix}${last ? "└─ " : "├─ "}`,
        order: own,
        children: walk(entry.children ?? [], `${prefix}${last ? "   " : "│  "}`),
      }
    })
  const rows = walk(entries, "")
  return { rows, next: order }
}
