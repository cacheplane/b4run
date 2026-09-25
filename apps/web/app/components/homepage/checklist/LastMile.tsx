import { Eyebrow } from "../../ui/Eyebrow"
import styles from "./checklist.module.css"
import { ProductionChecklist } from "./ProductionChecklist"

/**
 * "The last mile": the production checklist. The island is the whole demo;
 * the server renders every tile turned over, so each answer is in the page.
 */
export function LastMile() {
  return (
    <section id="last-mile" className={styles.section} aria-labelledby="last-mile-title">
      <div className={styles.intro}>
        <Eyebrow className={styles.eyebrow}>The last mile</Eyebrow>
        <h2 id="last-mile-title">The parts you'd write next are already here.</h2>
        <p>
          Twelve things an agent needs before real users reach it. Turn a tile over to see the file,
          config or command that handles it.
        </p>
      </div>
      <ProductionChecklist />
    </section>
  )
}
