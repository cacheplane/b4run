import { Eyebrow } from "../../ui/Eyebrow"
import { CodePanel } from "../CodePanel"
import { SchemaPlayground } from "../playground/SchemaPlayground"
import type { FolderTourData } from "./prepare"
import { TourClient } from "./TourClient"
import styles from "./tour.module.css"
import { TOUR_ROOT, type TourTab, tourStops } from "./tour-stops"

const tabs: readonly TourTab[] = tourStops.map(({ id, file, state }) => ({ id, file, state }))

/**
 * "Your first agent": the scaffolded hello agent, one file per stop. Every stop
 * renders here in full, stacked, so the page reads the same without
 * JavaScript; TourClient adds the chip bar's marker, the pinned tree and the
 * motion.
 */
export function FolderTour({ code, variants }: FolderTourData) {
  return (
    <section id="first-agent" className={styles.tour} aria-labelledby="first-agent-title">
      <div className={styles.intro}>
        <Eyebrow className={styles.eyebrow}>
          <span className={styles.markerDot} aria-hidden="true" />
          Your first agent
        </Eyebrow>
        <h2 id="first-agent-title">An agent is a folder.</h2>
        <p>
          Every file in src/app/hello/ is a feature. The scaffold starts you with three. Add a file
          and the agent gets the tools that come with it.
        </p>
      </div>
      <TourClient stops={tabs}>
        {tourStops.map((stop, index) => (
          <article
            key={stop.id}
            id={`tour-${stop.id}`}
            data-stop={index}
            className={styles.card}
            aria-labelledby={`tour-title-${stop.id}`}
            tabIndex={-1}
          >
            <div className={styles.cardCopy}>
              <p className={styles.cardFile}>
                <code>{`${TOUR_ROOT}${stop.file}`}</code>
                <span className={styles.badge} data-state={stop.state}>
                  {stop.state === "added" ? "+ added" : "scaffolded"}
                </span>
              </p>
              <h3 id={`tour-title-${stop.id}`}>{stop.title}</h3>
              <p>{stop.copy}</p>
              <a className={styles.docsLink} href={stop.docsHref}>
                {stop.docsLabel} →
              </a>
            </div>
            <div className={styles.cardPanel}>
              {stop.id === "greet" ? (
                <SchemaPlayground variants={variants} />
              ) : (
                <CodePanel code={code[stop.id]} />
              )}
            </div>
          </article>
        ))}
      </TourClient>
    </section>
  )
}
