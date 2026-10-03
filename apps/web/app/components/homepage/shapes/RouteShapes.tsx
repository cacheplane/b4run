import { Eyebrow } from "../../ui/Eyebrow"
import { type ShapeId, shapeLinks } from "./route-shapes"
import { ShapeSwitcher } from "./ShapeSwitcher"
import styles from "./shapes.module.css"

/**
 * "You keep the graph": the hello route written in each of the four shapes a
 * route can export. The switcher is the island; the server renders it with the
 * agent shape showing and every other shape in the DOM.
 */
export function RouteShapes({
  code,
}: {
  readonly code: Readonly<Record<ShapeId, readonly string[]>>
}) {
  return (
    <section id="route-shapes" className={styles.section} aria-labelledby="route-shapes-title">
      <div className={styles.intro}>
        <Eyebrow className={styles.eyebrow}>You keep the graph</Eyebrow>
        <h2 id="route-shapes-title">Pick the shape per route.</h2>
        <p>
          A route's index.ts exports one of four shapes. Let the model drive with an agent, or write
          the steps yourself as a workflow, a LangGraph graph or a chain.
        </p>
      </div>
      <ShapeSwitcher code={code} />
      <p className={styles.links}>
        {shapeLinks.map((link) => (
          <a key={link.href} href={link.href}>
            {link.label} →
          </a>
        ))}
      </p>
    </section>
  )
}
