import demoMedia from "../../../lib/demo-media.json"
import { NAVLOG_DEMO_URL } from "../../site-links"
import { Eyebrow } from "../../ui/Eyebrow"
import { SiteLink } from "../../ui/SiteLink"
import styles from "./demo.module.css"

const media = demoMedia.productLoop

/**
 * "See it run": the navlog demo video (docs/brand/demo), served from Blob with
 * the poster in public/. Nothing loads until the visitor presses play, and the
 * poster's size reserves the frame, so the section costs one image up front.
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
        {/* biome-ignore lint/a11y/useMediaCaption: the recording has no audio track; its on-screen text is in the transcript linked below */}
        <video
          className={styles.video}
          controls
          playsInline
          preload="none"
          poster={media.poster}
          width={1440}
          height={810}
          aria-label={media.ariaLabel}
        >
          <source src={media.webm} type="video/webm" />
          <source src={media.mp4} type="video/mp4" />
        </video>
        <figcaption className={styles.links}>
          <SiteLink href={NAVLOG_DEMO_URL}>Fly it live</SiteLink>
          <SiteLink href="/blog/how-we-built-navlog">How we built it</SiteLink>
          <SiteLink href={media.transcript}>Transcript</SiteLink>
        </figcaption>
      </figure>
    </section>
  )
}
