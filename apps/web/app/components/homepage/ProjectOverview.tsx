import styles from "./homepage.module.css"

const files = [
  { path: "b4.config.ts", note: "Runtime", href: "#workspace", depth: 0 },
  { path: "src/app/fix/", note: "Agent route", href: "#agent", depth: 0 },
  { path: "index.ts", note: "Agent", href: "#agent", depth: 1 },
  { path: "tools/", note: "Functions", href: "#tools", depth: 1 },
  { path: "plan.md", note: "Checklist", href: "#method", depth: 1 },
  { path: "skills/", note: "Instructions", href: "#method", depth: 1 },
  { path: "evals/", note: "Behavior checks", href: "#verification", depth: 1 },
  { path: "src/project/", note: "Workspace", href: "#workspace", depth: 0 },
  { path: "src/review/", note: "Verification", href: "#verification", depth: 0 },
  { path: "sample/", note: "Broken project", href: "#workspace", depth: 0 },
] as const

export function ProjectOverview() {
  return (
    <section id="project" className={styles.projectOverview} aria-labelledby="project-title">
      <div className={styles.overviewCopy}>
        <p className={styles.eyebrow}>The whole application</p>
        <h2 id="project-title">This project is the whole agent.</h2>
        <p>The agent repairs a broken CLI, verifies the patch, and asks for your approval.</p>
        <p className={styles.overviewHint}>Follow the files.</p>
      </div>
      <nav className={styles.projectTree} aria-label="Explore project files">
        <div className={styles.treeRoot}>code-fixer/</div>
        <ul>
          {files.map(({ path, note, href, depth }) => (
            <li key={path}>
              <a href={href} className={depth ? styles.treeChild : undefined}>
                <code>{path}</code>
                <span>{note}</span>
              </a>
            </li>
          ))}
        </ul>
        <p>B4 discovers the route’s agent, tools, plan, skills, and evals.</p>
      </nav>
    </section>
  )
}

const steps = [
  ["Request", "/fix#agent"],
  ["Repair", "Isolated workspace"],
  ["Verify", "Fresh workspace"],
  ["Pause", "B4 approval gate"],
  ["Approve", "Your decision"],
  ["Export", "Rechecked patch"],
] as const

export function ExecutionFlow() {
  return (
    <section id="workflow" className={styles.executionFlow} aria-labelledby="execution-title">
      <p className={styles.eyebrow}>The pieces in motion</p>
      <h2 id="execution-title">One request runs the whole workflow.</h2>
      <ol>
        {steps.map(([action, detail], index) => (
          <li key={action}>
            <span className={styles.flowNumber}>0{index + 1}</span>
            <strong>{action}</strong>
            <span>{detail}</span>
          </li>
        ))}
      </ol>
      <div className={styles.ownership}>
        <p>
          <strong>You write</strong> the task, tools, and acceptance rules.
        </p>
        <p>
          <strong>B4 runs</strong> the agent loop, workspaces, streaming, and approval.
        </p>
      </div>
    </section>
  )
}
