"use client"
import { useState } from "react"
import type {
  JsonValue,
  ObservedValue,
  PublicItem,
} from "../../../lib/turn-inspector/capture-types"
import styles from "./inspector.module.css"
import { ValueTree } from "./ValueTree"
export function Observed({ value }: { value: ObservedValue }) {
  if (!value.available) return <p className={styles.empty}>Not available in this recording</p>
  const text = typeof value.value === "string" ? value.value : JSON.stringify(value.value, null, 2)
  return <pre className={styles.value}>{text === "" ? "(empty)" : text}</pre>
}
export function ActivityDetails({ item }: { item: PublicItem | undefined }) {
  return item ? (
    <SelectedDetails key={item.id} item={item} />
  ) : (
    <div className={styles.empty}>Select a message or tool to inspect what the app observed.</div>
  )
}
function SelectedDetails({ item }: { item: PublicItem }) {
  const [mode, setMode] = useState(item.role === "tool" ? "Result" : "Content")
  const [format, setFormat] = useState<"Tree" | "JSON">("Tree")
  const modes = item.role === "tool" ? ["Arguments", "Result", "Event"] : ["Content", "Event"]
  const observed: ObservedValue =
    mode === "Arguments"
      ? item.input
      : mode === "Result"
        ? item.result
        : mode === "Event"
          ? { available: true, value: item as unknown as JsonValue }
          : item.content
  let treeValue = observed.available ? observed.value : null,
    derived = false
  if (observed.available && typeof observed.value === "string" && mode !== "Event") {
    try {
      const parsed: JsonValue = JSON.parse(observed.value)
      if (parsed !== null && typeof parsed === "object") {
        treeValue = parsed
        derived = true
      }
    } catch {
      /* Plain observed text remains text. */
    }
  }
  const structured = treeValue !== null && typeof treeValue === "object"
  return (
    <div className={styles.detailContent} data-details-id={item.id}>
      <fieldset className={styles.detailTabs} aria-label="Observed fields">
        {modes.map((label) => (
          <button
            type="button"
            key={label}
            aria-pressed={mode === label}
            onClick={() => setMode(label)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      <div className={styles.detailHeading}>
        <h4>{item.name || item.role}</h4>
        {structured && (
          <fieldset className={styles.segmented} aria-label="Value format">
            {(["Tree", "JSON"] as const).map((label) => (
              <button
                type="button"
                key={label}
                aria-pressed={format === label}
                onClick={() => setFormat(label)}
              >
                {label}
              </button>
            ))}
          </fieldset>
        )}
      </div>
      <div className={styles.detailBody}>
        {mode === "Event" && <p className={styles.detailNote}>Normalized observed item</p>}
        {derived && format === "Tree" && (
          <p className={styles.detailNote}>Parsed from the recorded JSON string</p>
        )}
        {!observed.available ? (
          <Observed value={observed} />
        ) : structured && format === "Tree" ? (
          <ValueTree key={mode} value={treeValue} />
        ) : (
          <pre className={styles.value}>
            {structured
              ? JSON.stringify(observed.value, null, 2)
              : typeof observed.value === "string"
                ? observed.value || "(empty)"
                : JSON.stringify(observed.value, null, 2)}
          </pre>
        )}
      </div>
      <footer className={styles.detailFooter}>
        {item.state} · {item.turnId.replace("turn-", "Turn ")} ·{" "}
        {item.provenance === "live" ? "Observed in app" : item.provenance}
      </footer>
    </div>
  )
}
