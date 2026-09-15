import { Capabilities } from "./Capabilities"
import { blueprintUrl, reportUrl } from "./evidence"
import { prepareHomepage } from "./highlight"
import styles from "./homepage.module.css"
import { Walkthrough } from "./Walkthrough"

const projectFiles = [
  ["fix/index.ts", "The agent."],
  ["fix/plan.md", "The plan."],
  ["fix/skills/verify-change/", "Reusable instructions."],
  ["fix/tools/prepareReview.ts", "Verify the exact candidate."],
  ["fix/tools/exportForReview.ts", "Export after approval."],
  ["b4.config.ts", "The runtime boundaries."],
] as const

export async function DeveloperHome() {
  const prepared = await prepareHomepage()
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
        <Walkthrough {...prepared.walkthrough} />
        <div className={styles.lower}>
          <p>
            A real historical bug, recreated in a controlled fixture.
            <br />
            Original source above. Qualified example below.
          </p>
          <a href={blueprintUrl} className={styles.cta}>
            Explore the example <span aria-hidden="true">↗</span>
          </a>
        </div>
        <Capabilities items={prepared.capabilities} />
        <section className={styles.fileStory} aria-labelledby="files-title">
          <div>
            <h3 id="files-title">
              Small files.
              <br />
              Clear responsibilities.
            </h3>
            <p>Find the behavior. Read it. Change it.</p>
          </div>
          <dl className={styles.fileRows}>
            {projectFiles.map(([path, meaning]) => (
              <div key={path}>
                <dt>{path}</dt>
                <dd>{meaning}</dd>
              </div>
            ))}
          </dl>
        </section>
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
            <p>
              Working code. Real fixtures.
              <br />
              Start with this agent. Build your own.
            </p>
            <a className={styles.cta} href="/blueprints/code-fixer.md">
              Open the installation guide <span aria-hidden="true">↗</span>
            </a>
          </div>
          <div>
            <p>
              With the B4 CLI available, this prints the installation guide for your coding agent to
              apply:
            </p>
            <pre className={styles.runCommand}>
              <code>b4 add code-fixer</code>
            </pre>
            <p>
              Pinned source. Tested with B4 0.8.32.
              <br />
              Node 24 · Git · Docker. Add an OpenAI API key for live runs.
              <br />
              Replay the fixtures without a model call.
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
