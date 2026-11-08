import { Fragment } from "react"
import type { ReplayState } from "../../../lib/turn-inspector/capture-types"
import { Observed } from "./ActivityDetails"
import { InspectorIcon } from "./InspectorIcon"
import styles from "./inspector.module.css"
export function ConversationPane({
  state,
  turnId,
  selectedId,
  onSelect,
}: {
  state: ReplayState
  turnId: string | null
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <>
      {state.items
        .filter((i) => !turnId || i.turnId === turnId)
        .map((item, index, items) => (
          <Fragment key={item.id}>
            {(index === 0 || items[index - 1]?.turnId !== item.turnId) && (
              <p className={styles.turnHeading}>{item.turnId.replace("turn-", "Turn ")}</p>
            )}
            <article
              className={styles.item}
              data-role={item.role}
              data-selected={item.id === selectedId}
            >
              <button
                type="button"
                data-item-id={item.id}
                aria-pressed={item.id === selectedId}
                onClick={() => onSelect(item.id)}
              >
                {item.role === "tool" && <InspectorIcon name="tool" />}
                <span>{item.name || item.role}</span>
                <span className={styles.itemState}>{item.state}</span>
              </button>
              {item.role !== "tool" && (
                <div className={styles.message}>
                  <Observed value={item.content} />
                </div>
              )}
            </article>
          </Fragment>
        ))}
      {state.requests
        .filter((r) => !turnId || r.turnId === turnId)
        .map((request) => (
          <section className={styles.request} key={request.id}>
            <h4>Recorded request · {request.state}</h4>
            <Observed value={request.prompt} />
            {request.state === "resolved" &&
              (request.decision.available ? (
                <>
                  <h5>Recorded decision</h5>
                  <Observed value={request.decision} />
                </>
              ) : (
                <p>Decision not available in this recording</p>
              ))}
          </section>
        ))}
      {state.turns
        .filter((t) => !turnId || t.id === turnId)
        .map((turn) => (
          <p key={turn.id}>
            {turn.id} · {turn.status} · {turn.outcome ?? "Outcome unknown"}
          </p>
        ))}
      {state.notices.map((notice, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Notices are immutable append-only observations, including repeated codes.
        <p key={`${index}-${notice.code}`}>{notice.text}</p>
      ))}
    </>
  )
}
