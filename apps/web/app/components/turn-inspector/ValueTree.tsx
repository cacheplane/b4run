"use client"
import { useState } from "react"
import type { JsonValue } from "../../../lib/turn-inspector/capture-types"
import styles from "./inspector.module.css"
/** Expandable observed values; native disclosures provide keyboard interaction. */
export function ValueTree({
  value,
  name = "value",
  depth = 0,
}: {
  value: JsonValue
  name?: string
  depth?: number
}) {
  const [open, setOpen] = useState(depth === 0),
    [limit, setLimit] = useState(50),
    [expanded, setExpanded] = useState(false)
  if (value === null || typeof value !== "object") {
    const text = typeof value === "string" ? JSON.stringify(value) : String(value)
    return (
      <div className={styles.treeLeaf}>
        <span className={styles.treeKey}>{name}: </span>
        <span>
          {expanded ? text : text.slice(0, 240)}
          {!expanded && text.length > 240 ? "…" : ""}
        </span>
        {text.length > 240 && (
          <button type="button" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show less" : "Show full value"}
          </button>
        )}
      </div>
    )
  }
  if (depth >= 8)
    return (
      <div className={styles.treeLeaf}>
        {name}: nesting limit reached. Use JSON to read this value.
      </div>
    )
  const entries = Object.entries(value)
  return (
    <details
      className={styles.treeBranch}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <span className={styles.treeKey}>{name}</span>{" "}
        <span className={styles.muted}>
          {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
        </span>
      </summary>
      {open && (
        <div className={styles.treeChildren}>
          {entries.slice(0, limit).map(([key, child]) => (
            <ValueTree key={key} name={key} value={child} depth={depth + 1} />
          ))}
          {entries.length > limit && (
            <button type="button" onClick={() => setLimit((n) => n + 50)}>
              Show next {Math.min(50, entries.length - limit)} entries
            </button>
          )}
        </div>
      )}
    </details>
  )
}
