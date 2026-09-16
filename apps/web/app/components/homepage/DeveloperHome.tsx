import { reportUrl, sourceUrl } from "./evidence"
import { prepareHomepage } from "./highlight"
import styles from "./homepage.module.css"
import { Narrative } from "./Narrative"
import { prepareNarrative } from "./narrative-source"
import { Walkthrough } from "./Walkthrough"

export async function DeveloperHome() {
  const [prepared, narrative] = await Promise.all([prepareHomepage(), prepareNarrative()])
  return (
    <div className={styles.home}>
      <div className={styles.container}>
        <section className={styles.hero} aria-labelledby="home-title">
          <p className={styles.eyebrow}>The TypeScript framework for agents.</p>
          <h1 id="home-title">
            Ridiculous speed.
            <br />
            Readable code.
          </h1>
          <p>
            Write the agent. Give it tools. Set the limits.
            <br />
            Ship code you can actually read.
          </p>
          <span className={styles.dot} aria-hidden="true" />
        </section>
        <Narrative code={narrative} />
        <details className={styles.recording}>
          <summary>
            <span>
              <span className={styles.eyebrow}>See it in action</span>
              <strong>Watch the recorded repair.</strong>
            </span>
            <span>
              1m 53s · edited highlights <span aria-hidden="true">＋</span>
            </span>
          </summary>
          <p className={styles.sourceNote}>
            Historical defect, earlier implementation. Recorded timing applies to this run only.
          </p>
          <Walkthrough {...prepared.walkthrough} />
          <div className={styles.lower}>
            <a href={sourceUrl("README.md")} className={styles.textLink}>
              Explore the recorded example ↗
            </a>
            <a href={reportUrl} className={styles.textLink}>
              See every attempt, including the failures ↗
            </a>
          </div>
        </details>
        <section className={styles.takeaway} aria-labelledby="run-title">
          <div>
            <p className={styles.eyebrow}>Your next commit starts here</p>
            <h2 id="run-title">
              Read it.
              <br />
              Run it.
              <br />
              Make it yours.
            </h2>
            <p>Start with this agent. Make it yours.</p>
            <a className={styles.cta} href="/blueprints/code-fixer.md">
              Open the installation guide <span aria-hidden="true">↗</span>
            </a>
          </div>
          <div>
            <p>The B4 CLI prints the installation guide for your coding agent:</p>
            <pre className={styles.runCommand}>
              <code>b4 add code-fixer</code>
            </pre>
            <p>
              Qualified installation · B4 0.8.32 · Earlier source.
              <br />
              Node 24 · Git · Docker · API key for live runs.
              <br />
              Replay the sample without a model call.
            </p>
            <a href="/docs/cli#b4-add" className={styles.reportLink}>
              Using the B4 CLI ↗
            </a>
            <br />
            <a
              href="https://github.com/cacheplane/b4run/blob/main/examples/code-fixer/server/WALKTHROUGH.md"
              className={styles.reportLink}
            >
              Read the code walkthrough ↗
            </a>
            <br />
            <a href={reportUrl} className={styles.reportLink}>
              See every attempt, including the failures ↗
            </a>
          </div>
        </section>
      </div>
    </div>
  )
}
