import { CopyCommand } from "../ui/CopyCommand"
import { Eyebrow } from "../ui/Eyebrow"
import { reportUrl, sourceUrl } from "./evidence"
import { prepareHomepage } from "./highlight"
import styles from "./homepage.module.css"
import { Narrative } from "./Narrative"
import { prepareNarrative } from "./narrative-source"
import { Walkthrough } from "./Walkthrough"

export async function DeveloperHome() {
  const [prepared, narrative] = await Promise.all([prepareHomepage(), prepareNarrative()])
  return (
    <main id="content" tabIndex={-1} className={styles.home}>
      <div className={styles.container}>
        <section className={styles.hero} aria-labelledby="home-title">
          <Eyebrow className={styles.eyebrow}>The TypeScript framework for agents.</Eyebrow>
          <h1 id="home-title">
            Ridiculous speed.
            <br />
            Readable code.
          </h1>
          <p>
            Write the agent, give it tools, and set its limits.
            <br />
            You ship code you can actually read.
          </p>
          <span className={styles.dot} aria-hidden="true" />
        </section>
        <Narrative code={narrative} />
        <details className={styles.recording}>
          <summary>
            <span>
              <span className={styles.eyebrow} data-ui="eyebrow" data-tone="muted">
                See it in action
              </span>
              <strong>Watch the recorded repair.</strong>
            </span>
            <span>
              1m 53s · edited highlights <span aria-hidden="true">＋</span>
            </span>
          </summary>
          <Walkthrough {...prepared.walkthrough} />
          <div className={styles.lower}>
            <a href={sourceUrl("README.md")} className={styles.textLink}>
              Explore the recorded example
            </a>
            <a href={reportUrl} className={styles.textLink}>
              See every attempt, including the failures
            </a>
          </div>
        </details>
        <section className={styles.takeaway} aria-labelledby="run-title">
          <div>
            <Eyebrow tone="panel" className={styles.eyebrow}>
              Get started
            </Eyebrow>
            <h2 id="run-title">Build your own agent.</h2>
            <p>Scaffold a new B4 app with one command:</p>
            <CopyCommand command="npm create b4-app@latest my-agent" variant="dark" />
          </div>
          <div>
            <p>
              To start from this code fixer, run <code>b4 add code-fixer</code> and give the printed
              guide to your coding agent. It needs Node 24, Git, and Docker, plus an API key for
              live runs.
            </p>
            <a href="/docs/cli#b4-add" className={styles.reportLink}>
              Using the B4 CLI
            </a>
            <br />
            <a
              href="https://github.com/cacheplane/b4run/blob/main/examples/code-fixer/server/WALKTHROUGH.md"
              className={styles.reportLink}
            >
              Read the code walkthrough
            </a>
          </div>
        </section>
      </div>
    </main>
  )
}
