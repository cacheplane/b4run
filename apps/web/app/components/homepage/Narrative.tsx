import type { ReactNode } from "react"
import { Eyebrow } from "../ui/Eyebrow"
import { CodePanel } from "./CodePanel"
import styles from "./homepage.module.css"
import type { NarrativeKey } from "./narrative-source"
import { ExecutionFlow, ProjectOverview } from "./ProjectOverview"
import type { DisplayCode } from "./types"

function Chapter({
  id,
  number,
  label,
  title,
  children,
  code,
}: {
  id: string
  number: string
  label: string
  title: string
  children: ReactNode
  code: ReactNode
}) {
  return (
    <section className={styles.chapter} id={id} aria-labelledby={`${id}-title`}>
      <div className={styles.chapterCopy}>
        <Eyebrow className={styles.eyebrow}>
          <span className={styles.chapterNumber}>{number}</span>
          {label}
        </Eyebrow>
        <h2 id={`${id}-title`}>{title}</h2>
        {children}
      </div>
      <div className={styles.chapterCode}>{code}</div>
    </section>
  )
}

export function Narrative({ code }: { code: Record<NarrativeKey, DisplayCode> }) {
  return (
    <div data-narrative="current-example">
      <ProjectOverview />
      <Chapter
        id="agent"
        number="01"
        label="Declare the agent"
        title="This code runs this agent."
        code={<CodePanel code={code.agent} />}
      >
        <p>Choose a model and a task. B4 runs the tool-call loop.</p>
        <a className={styles.textLink} href="/docs/agents">
          Agents →
        </a>
      </Chapter>
      <Chapter
        id="workspace"
        number="02"
        label="Workspaces + sandboxes"
        title="Give it somewhere to work."
        code={
          <>
            <CodePanel code={code.workspace} />
            <div className={styles.codeCaption}>Run it in Docker.</div>
            <CodePanel code={code.sandbox} />
          </>
        }
      >
        <p>Declare the files. B4 manages their lifecycle in an isolated Docker workspace.</p>
        <a className={styles.textLink} href="/docs/sandbox">
          Workspaces + sandboxes →
        </a>
      </Chapter>
      <Chapter
        id="tools"
        number="03"
        label="Typed tools"
        title="Your functions become its tools."
        code={<CodePanel code={code.tool} />}
      >
        <p>
          Export a function. B4 derives its schema from your types and supplies <code>ctx</code>.
        </p>
        <a className={styles.textLink} href="/docs/tools">
          Tools →
        </a>
      </Chapter>
      <Chapter
        id="method"
        number="04"
        label="Plans + skills"
        title="Give it a working method."
        code={
          <>
            <CodePanel code={code.plan} />
            <div className={styles.skillNote}>
              <span>skills/verify-change/SKILL.md</span>
              <p>Reproduce. Repair. Verify. Request review.</p>
            </div>
          </>
        }
      >
        <p>A plan seeds the checklist. Skills provide reusable instructions.</p>
        <a className={styles.textLink} href="/docs/skills">
          Plans + skills →
        </a>
      </Chapter>
      <Chapter
        id="verification"
        number="05"
        label="Independent verification"
        title="Define what “done” means."
        code={<CodePanel code={code.checks} />}
      >
        <p>Test the patch in a fresh workspace. Require every named check to pass.</p>
        <a className={styles.textLink} href="/docs/evals">
          Evaluate the workflow →
        </a>
      </Chapter>
      <Chapter
        id="approval"
        number="06"
        label="Human approval"
        title="The next action is your call."
        code={
          <>
            <CodePanel code={code.approval} />
            <div className={styles.codeCaption}>Recheck after approval.</div>
            <CodePanel code={code.export} />
          </>
        }
      >
        <p>B4 pauses before export. You approve the exact patch, and the tool checks it again.</p>
        <a className={styles.textLink} href="/docs/permissions">
          Approval →
        </a>
      </Chapter>
      <ExecutionFlow />
    </div>
  )
}
