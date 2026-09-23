import { CopyCommand } from "../ui/CopyCommand"
import styles from "./blog.module.css"

export function BlogCta() {
  return (
    <section className={styles.cta} aria-labelledby="blog-cta-title">
      <div className={styles.ctaInner}>
        <h2 id="blog-cta-title">Build your own agent.</h2>
        <p>
          Start a project, or follow the code-fixer agent from its first failing test to a verified
          patch.
        </p>
        <div className={styles.ctaLinks}>
          <CopyCommand command="npm create b4-app@latest my-agent" variant="dark" />
          <a href="https://github.com/cacheplane/b4run/blob/main/examples/code-fixer/server/WALKTHROUGH.md">
            Read the developer walkthrough
          </a>
        </div>
      </div>
    </section>
  )
}
