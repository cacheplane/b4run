import type { ObservedValue, PublicItem } from "../../../lib/turn-inspector/capture-types"
import styles from "./inspector.module.css"
export function Observed({ value }: { value: ObservedValue }) {
  if (!value.available) return <p>Not available in this recording</p>
  const text = typeof value.value === "string" ? value.value : JSON.stringify(value.value, null, 2)
  return <pre className={styles.value}>{text === "" ? "(empty)" : text}</pre>
}
export function ActivityDetails({ item }: { item: PublicItem | undefined }) {
  if (!item) return <p>Select a message or tool to inspect what the app observed.</p>
  return (
    <div data-details-id={item.id}>
      <h4>{item.name || item.type}</h4>
      <p>
        {item.state} · {item.provenance}
      </p>
      <h5>Content</h5>
      <Observed value={item.content} />
      {item.role === "tool" && (
        <>
          <h5>Input</h5>
          <Observed value={item.input} />
          <h5>Result</h5>
          <Observed value={item.result} />
        </>
      )}
    </div>
  )
}
