import { Eyebrow } from "../../ui/Eyebrow"
import { DeployTargets } from "./DeployTargets"
import styles from "./ship.module.css"
import { shipLinks, type TargetId } from "./ship-data"
import { TestReplay } from "./TestReplay"

/**
 * "Test and ship": the scaffold's recorded tests beside the deploy targets.
 * Each half is its own island; the server renders both complete.
 */
export function TestAndShip({
  code,
}: {
  readonly code: Readonly<Record<TargetId, readonly string[]>>
}) {
  return (
    <section id="test-and-ship" className={styles.section} aria-labelledby="test-and-ship-title">
      <div className={styles.intro}>
        <Eyebrow className={styles.eyebrow}>Test and ship</Eyebrow>
        <h2 id="test-and-ship-title">Test it offline, then pick where it runs.</h2>
        <p>
          The scaffold's test and eval answer from script() fixtures instead of a model, so they
          need no API key. One line of b4.config.ts picks what b4 build emits.
        </p>
      </div>
      <div className={styles.columns}>
        <div className={styles.column}>
          <h3 className={styles.columnTitle}>npm test and b4 eval</h3>
          <p className={styles.columnNote}>
            Recorded in a fresh scaffold, with no OPENAI_API_KEY set.
          </p>
          <TestReplay />
        </div>
        <div className={styles.column}>
          <h3 className={styles.columnTitle}>b4 build</h3>
          <p className={styles.columnNote}>
            node and langsmith are the defaults. Setting build.targets replaces them.
          </p>
          <DeployTargets code={code} />
        </div>
      </div>
      <p className={styles.links}>
        {shipLinks.map((link) => (
          <a key={link.href} href={link.href}>
            {link.label} →
          </a>
        ))}
      </p>
    </section>
  )
}
