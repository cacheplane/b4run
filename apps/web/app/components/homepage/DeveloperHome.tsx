import { Capabilities } from "./Capabilities"
import { blueprintUrl, reportUrl } from "./evidence"
import { prepareHomepage } from "./highlight"
import styles from "./homepage.module.css"
import { Walkthrough } from "./Walkthrough"

const projectFiles = [
  ["fix/index.ts", "The agent."],
  ["fix/plan.md", "The plan."],
  ["fix/skills/verify-change/", "Reusable instructions."],
  ["fix/tools/exportForReview.ts", "Your tool. Your TypeScript."],
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
            <br />A recorded fix. Every line inspectable.
          </p>
          <a href={blueprintUrl} className={styles.cta}>
            Get the code <span aria-hidden="true">↗</span>
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
            <a className={styles.cta} href={`${blueprintUrl}#run-from-the-monorepo-root`}>
              Get the blueprint <span aria-hidden="true">↗</span>
            </a>
          </div>
          <div>
            <p>
              After installing dependencies, building the packages, and preparing the fixture image,
              run from the repository root:
            </p>
            <pre className={styles.runCommand}>
              <code>
                {
                  "B4_CODE_FIXER_MODEL=gpt-5 \\\npnpm --filter @b4-example/code-fixer-server \\\nrun:agent -- --task cli-flags"
                }
              </code>
            </pre>
            <p>
              Node 24 · pnpm · Docker · OpenAI API key
              <br />
              The README covers setup and replay without a model call.
            </p>
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
