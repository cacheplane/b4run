import type { CSSProperties } from "react"
import styles from "./scaffold-terminal.module.css"
import { layoutTree, scaffoldTree, type TreeRow } from "./scaffold-tree"

/** The reveal slot a line takes; scaffold-terminal.module.css turns it into a delay. */
const slot = (order: number) => ({ "--i": order }) as CSSProperties

function Row({ row }: { row: TreeRow }) {
  const content = (
    <>
      <span className={styles.file}>
        <span className={styles.glyph} aria-hidden="true">
          {row.glyph}
        </span>
        {row.href !== undefined ? <span className={styles.marker} aria-hidden="true" /> : null}
        {row.label}
      </span>
      <span className="sr-only">, </span>
      <span className={styles.note}>
        {row.note}
        {row.href !== undefined ? <span aria-hidden="true"> ↓</span> : null}
      </span>
    </>
  )
  return row.href !== undefined ? (
    <a href={row.href} className={[styles.row, styles.agent].join(" ")}>
      {content}
    </a>
  ) : (
    <span className={styles.row}>{content}</span>
  )
}

function Rows({ rows }: { rows: readonly TreeRow[] }) {
  return (
    <ul className={styles.tree}>
      {rows.map((row) => (
        <li key={row.label} className={styles.line} style={slot(row.order)}>
          <Row row={row} />
          {row.children.length > 0 ? <Rows rows={row.children} /> : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * What `npm create b4-app` scaffolds, as a terminal. Server-rendered in its
 * final layout; the line-by-line reveal is CSS only and skipped under
 * reduced motion.
 */
export function ScaffoldTerminal() {
  const { command, created, root, entries, next } = scaffoldTree
  const tree = layoutTree(entries, 3)
  return (
    <figure className={styles.terminal} style={{ "--last": tree.next } as CSSProperties}>
      <figcaption className="sr-only">What npm create b4-app scaffolds</figcaption>
      <div className={styles.strip} aria-hidden="true">
        terminal
      </div>
      <div className={styles.body}>
        <p className={styles.line} style={slot(0)}>
          <span className={styles.prompt} aria-hidden="true">
            ${" "}
          </span>
          {command}
        </p>
        <p className={[styles.line, styles.created].join(" ")} style={slot(1)}>
          <span className={styles.prompt} aria-hidden="true">
            ✔{" "}
          </span>
          {created}
        </p>
        <p className={styles.line} style={slot(2)}>
          {root}
        </p>
        <Rows rows={tree.rows} />
      </div>
      <p className={styles.next}>
        <span className={styles.prompt} aria-hidden="true">
          ${" "}
        </span>
        {next}
      </p>
    </figure>
  )
}
