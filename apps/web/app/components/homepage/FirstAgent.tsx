import { Eyebrow } from "../ui/Eyebrow"
import { CodePanel } from "./CodePanel"
import type { FirstAgentKey } from "./first-agent-source"
import styles from "./homepage.module.css"
import type { DisplayCode } from "./types"

export function FirstAgent({ code }: { code: Record<FirstAgentKey, DisplayCode> }) {
  return (
    <section className={styles.chapter} id="first-agent" aria-labelledby="first-agent-title">
      <div className={styles.chapterCopy}>
        <Eyebrow className={styles.eyebrow}>Your first agent</Eyebrow>
        <h2 id="first-agent-title">An agent is a folder.</h2>
        <p>
          Export a function from tools/ and your agent can call it. B4 reads the input type and
          writes the schema.
        </p>
        <a className={styles.textLink} href="/docs/tools">
          Tools →
        </a>
      </div>
      <div className={styles.chapterCode}>
        <CodePanel code={code.agent} />
        <div className={styles.codeCaption}>Add a tool next to it:</div>
        <CodePanel code={code.tool} />
      </div>
    </section>
  )
}
