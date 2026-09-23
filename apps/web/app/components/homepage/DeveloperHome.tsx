import { CopyCommand } from "../ui/CopyCommand"
import { Eyebrow } from "../ui/Eyebrow"
import { FirstAgent } from "./FirstAgent"
import { prepareFirstAgent } from "./first-agent-source"
import { prepareHomepage } from "./highlight"
import styles from "./homepage.module.css"
import { Narrative } from "./Narrative"
import { exampleFileUrl, exampleUrl, prepareNarrative } from "./narrative-source"
import { Walkthrough } from "./Walkthrough"

const createCommand = "npm create b4-app@latest my-agent"

export async function DeveloperHome() {
  const [prepared, narrative, firstAgent] = await Promise.all([
    prepareHomepage(),
    prepareNarrative(),
    prepareFirstAgent(),
  ])
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
          <div className={styles.heroActions}>
            <CopyCommand command={createCommand} className={styles.command ?? ""} />
            <a href="/docs/getting-started" className={styles.textLink}>
              Get started
            </a>
          </div>
          <span className={styles.dot} aria-hidden="true" />
        </section>
        <FirstAgent code={firstAgent} />
        <div className={styles.recording}>
          <div className={styles.recordingHeader}>
            <Eyebrow className={styles.eyebrow}>See it in action</Eyebrow>
            <Eyebrow className={styles.eyebrow}>6m 14s · edited highlights</Eyebrow>
          </div>
          <Walkthrough {...prepared.walkthrough} />
          <div className={styles.lower}>
            <a
              href={exampleUrl}
              className={styles.textLink}
              target="_blank"
              rel="noopener noreferrer"
            >
              Explore the example
            </a>
          </div>
        </div>
        <Narrative code={narrative} />
        <section className={styles.takeaway} aria-labelledby="run-title">
          <div>
            <Eyebrow tone="panel" className={styles.eyebrow}>
              Get started
            </Eyebrow>
            <h2 id="run-title">Build your own agent.</h2>
            <p>Scaffold a new B4 app with one command:</p>
            <CopyCommand command={createCommand} variant="dark" className={styles.command ?? ""} />
            <br />
            <a href="/docs/getting-started" className={styles.reportLink}>
              Getting Started
            </a>
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
              href={exampleFileUrl("server/WALKTHROUGH.md")}
              className={styles.reportLink}
              target="_blank"
              rel="noopener noreferrer"
            >
              Read the code walkthrough
            </a>
          </div>
        </section>
      </div>
    </main>
  )
}
