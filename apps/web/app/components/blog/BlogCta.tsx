import { UPDATES_FORM_ENABLED } from "../../lib/growth/updates-enabled"
import { CopyCommand } from "../ui/CopyCommand"
import styles from "./blog.module.css"

export function BlogCta() {
  return (
    <section className={styles.cta} data-signal-surface="blog" aria-labelledby="blog-cta-title">
      <div className={styles.ctaInner}>
        <h2 id="blog-cta-title">Build your own agent.</h2>
        <p>Scaffold a project and walk through every file it gives you.</p>
        <div className={styles.ctaLinks}>
          <CopyCommand command="npm create b4-app@latest my-agent" variant="dark" surface="blog" />
          <a href="/docs/getting-started" data-cta-id="blog_cta_get_started">
            Read Getting Started
          </a>
          {UPDATES_FORM_ENABLED ? (
            <a href="/updates" data-cta-id="blog_cta_updates">
              Get updates from Brian
            </a>
          ) : null}
        </div>
      </div>
    </section>
  )
}
