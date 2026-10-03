import { CopyCommand } from "../ui/CopyCommand"
import styles from "./blog.module.css"

export function BlogCta() {
  return (
    <section className={styles.cta} aria-labelledby="blog-cta-title">
      <div className={styles.ctaInner}>
        <h2 id="blog-cta-title">Build your own agent.</h2>
        <p>Scaffold a project and walk through every file it gives you.</p>
        <div className={styles.ctaLinks}>
          <CopyCommand command="npm create b4-app@latest my-agent" variant="dark" />
          <a href="/docs/getting-started">Read Getting Started</a>
        </div>
      </div>
    </section>
  )
}
