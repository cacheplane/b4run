import demoMedia from "../../../lib/demo-media.json"
import { NAVLOG_DEMO_URL } from "../../site-links"
import { Eyebrow } from "../../ui/Eyebrow"
import { SiteLink } from "../../ui/SiteLink"
import { AutoplayVideo } from "./AutoplayVideo"
import styles from "./demo.module.css"

const media = demoMedia.productLoop

/**
 * "See it run": the navlog demo video (docs/brand/demo), served from Blob with
 * the poster in public/. It plays, muted, once it scrolls into view
 * (`AutoplayVideo`); until then the poster, whose size reserves the frame, is
 * the only thing the section loads.
 */
export function DemoVideo() {
  return (
    <section id="demo" className={styles.section} aria-labelledby="demo-title">
      <div className={styles.intro}>
        <Eyebrow className={styles.eyebrow}>See it run</Eyebrow>
        <h2 id="demo-title">Watch a real agent plan a flight.</h2>
        <p>
          The navlog example plans a VFR flight for a Cessna 172N. Each feature shows in code, then
          running in the Workbench: the route, the computed weather verdict, the approval before
          filing, and the memory that restores the thread.
        </p>
      </div>
      <figure className={styles.figure}>
        <AutoplayVideo
          className={styles.video}
          poster={media.poster}
          width={1440}
          height={810}
          ariaLabel={media.ariaLabel}
        >
          <source src={media.webm} type="video/webm" />
          <source src={media.mp4} type="video/mp4" />
        </AutoplayVideo>
        <figcaption className={styles.links}>
          <SiteLink href={NAVLOG_DEMO_URL}>Fly it live</SiteLink>
          <SiteLink href="/blog/how-we-built-navlog">How we built it</SiteLink>
          <SiteLink href={media.transcript}>Transcript</SiteLink>
        </figcaption>
      </figure>
    </section>
  )
}
