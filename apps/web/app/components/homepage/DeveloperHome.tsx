import { CopyCommand } from "../ui/CopyCommand"
import { Eyebrow } from "../ui/Eyebrow"
import { LastMile } from "./checklist/LastMile"
import { Guardrails } from "./gates/Guardrails"
import { prepareGates } from "./gates/prepare"
import styles from "./homepage.module.css"
import { ScaffoldTerminal } from "./ScaffoldTerminal"
import { scaffoldTree } from "./scaffold-tree"
import { prepareRouteShapes } from "./shapes/prepare"
import { RouteShapes } from "./shapes/RouteShapes"
import { prepareDeployTargets } from "./ship/prepare"
import { TestAndShip } from "./ship/TestAndShip"
import { FolderTour } from "./tour/FolderTour"
import { prepareFolderTour } from "./tour/prepare"

const createCommand = scaffoldTree.command

export async function DeveloperHome() {
  const [tour, gates, shapes, targets] = await Promise.all([
    prepareFolderTour(),
    prepareGates(),
    prepareRouteShapes(),
    prepareDeployTargets(),
  ])
  return (
    <main id="content" tabIndex={-1} className={styles.home}>
      <div className={styles.container}>
        <section className={styles.hero} aria-labelledby="home-title">
          <div className={styles.heroCopy}>
            <Eyebrow className={styles.eyebrow}>An agent framework, the way I'd build it.</Eyebrow>
            <h1 id="home-title">
              Ridiculous speed.
              <br />
              Readable code.
            </h1>
            <p className={styles.lede}>
              Write the agent in TypeScript, give it tools, and set its limits.
              <br />
              You ship code you can actually read.
            </p>
            <p className={styles.runtime}>Runs on LangGraph.js. You keep the graph.</p>
            <div className={styles.heroActions}>
              <CopyCommand command={createCommand} className={styles.command ?? ""} />
              <a href="/docs/getting-started" className={styles.textLink}>
                Get started →
              </a>
            </div>
          </div>
          <div className={styles.heroVisual}>
            <span className={styles.eclipse} aria-hidden="true" />
            <ScaffoldTerminal />
          </div>
        </section>
        <FolderTour {...tour} />
        <Guardrails {...gates} />
        <RouteShapes code={shapes} />
        <TestAndShip code={targets} />
        <LastMile />
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
              Getting Started →
            </a>
          </div>
        </section>
      </div>
    </main>
  )
}
