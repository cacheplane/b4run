# Homepage Scaffold Hero Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the b4.run homepage hero's decorative dot with a terminal that shows what `npm create b4-app` scaffolds, add the LangGraph line, and give the Relay dot two jobs: an eclipse behind the terminal, and a marker linking the tree's `src/app/hello/` row to the "Your first agent" section.

**Architecture:** Tree data lives in `scaffold-tree.json`, with a typed accessor and a pure `layoutTree()` that computes box-drawing glyphs and reveal order. A test pins the data to the real `app-basic` template and the real `create-b4-app` output. `ScaffoldTerminal` is a server component; its reveal is CSS-only and gated on `prefers-reduced-motion: no-preference`. The hero becomes a two-column grid; `.home` clips overflow so the eclipse crops at the page edges.

**Tech Stack:** Next.js 16 (app router, server components), CSS modules, Vitest (jsdom + `renderToString`), Biome.

**Spec:** `docs/superpowers/specs/2026-09-24-homepage-scaffold-hero-design.md`

**Deviations from the spec, and why:**
- The terminal's CSS goes in a new `scaffold-terminal.module.css`, not the 801-line `homepage.module.css`. `homepage.module.css` already has `.treeRoot`, and one focused file avoids name collisions.
- The spec scoped `overflow-x: clip` to the hero. But the hero sits inside the 1200px `.container`, so clipping there cuts the eclipse off mid-page instead of at the page edge. So `.home` (full-width `<main>`) gets `overflow: clip` instead. That keeps the skill's concern satisfied: `clip` is not a scroll container, so nothing inside becomes scrollable, and nothing on the page overflows `.home` today (at 375px, `scrollWidth === innerWidth`). The clip on both axes also trims the eclipse at the top of `<main>`, just under the header, so it can never paint over the header. Task 6 verifies no content is clipped.
- The spec's "no `.dot` element remains" test becomes "the hero has no decorative element as a direct child". CSS-module class names are hashed in tests, so we can't look up `.dot` by name.

**Rules that apply to every task** (from `AGENTS.md` and the website design system):
- Run commands from the repo root. Use Node 24 (`nvm use 24`).
- In `app/`, no hex colours, no `rgba()`/`hsl()`/named colours in CSS, `border-radius` only `0` or `50%`, and the words `rounded`/`shadow-x` must not appear anywhere in source, including comments. All colours are `var(--color-*)` from `app/styles/tokens.css`. `app/styles/design-system.test.ts` enforces this.
- `exactOptionalPropertyTypes` is on: never write `{ href: undefined }`; use a conditional spread.
- Never run bare `biome check --write`; use `pnpm --dir apps/web lint`.
- `next dev` writes `apps/web/AGENTS.md`, `apps/web/CLAUDE.md` and touches `apps/web/next-env.d.ts`. Before any `git add`, run `git status` and restore or delete them.

---

## File Structure

| File | Responsibility |
|---|---|
| Create `apps/web/app/components/homepage/scaffold-tree.json` | The terminal's content: the command, the created line, the tree root, the entries, and the next-step command. |
| Create `apps/web/app/components/homepage/scaffold-tree.ts` | Types, the typed data export, and `layoutTree()` (glyphs + reveal order). |
| Create `apps/web/app/components/homepage/scaffold-tree.test.ts` | Pins the data to `packages/devkit/templates/app-basic` and `packages/create-b4-app/src/index.ts`; tests `layoutTree`. |
| Create `apps/web/app/components/homepage/ScaffoldTerminal.tsx` | Server component: renders the `<figure>`. |
| Create `apps/web/app/components/homepage/scaffold-terminal.module.css` | Terminal styles, responsive notes, reveal motion. |
| Modify `apps/web/app/components/homepage/DeveloperHome.tsx` | Two-column hero, LangGraph line, eclipse, terminal; dot removed; command from `scaffoldTree`. |
| Modify `apps/web/app/components/homepage/homepage.module.css` | Hero grid, `.heroCopy`, `.heroVisual`, `.eclipse`, `.lede`, `.runtime`, `.markerDot`; `.home` clip; `.dot` removed. |
| Modify `apps/web/app/components/homepage/FirstAgent.tsx` | Marker dot in the eyebrow. |
| Modify `apps/web/app/components/homepage/homepage.test.tsx` | Hero and marker assertions. |
| Modify `apps/web/app/seo/lastmod.generated.json` | Regenerated (Task 6). |

---

### Task 1: Scaffold tree data, layout, and the template pin

**Files:**
- Create: `apps/web/app/components/homepage/scaffold-tree.json`
- Create: `apps/web/app/components/homepage/scaffold-tree.ts`
- Test: `apps/web/app/components/homepage/scaffold-tree.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/components/homepage/scaffold-tree.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { layoutTree, type ScaffoldEntry, scaffoldTree } from "./scaffold-tree"

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url))
const templateRoot = resolve(repoRoot, "packages/devkit/templates/app-basic")
const cli = readFileSync(resolve(repoRoot, "packages/create-b4-app/src/index.ts"), "utf8")
const appName = scaffoldTree.command.split(" ").at(-1)

const flatten = (entries: readonly ScaffoldEntry[]): ScaffoldEntry[] =>
  entries.flatMap((entry) => [entry, ...flatten(entry.children ?? [])])

describe("the hero terminal shows what the scaffold really creates", () => {
  it("lists only files the basic template ships", () => {
    for (const { path } of flatten(scaffoldTree.entries)) {
      const shipped =
        existsSync(resolve(templateRoot, path)) || existsSync(resolve(templateRoot, `${path}.template`))
      expect(shipped, path).toBe(true)
    }
  })

  it("labels each entry with the end of its own path", () => {
    for (const { path, label } of flatten(scaffoldTree.entries)) {
      expect(path.endsWith(label.replace(/\/$/, "")), `${label} vs ${path}`).toBe(true)
    }
  })

  it("prints the line create-b4-app prints, for its default template", () => {
    expect(scaffoldTree.command).toBe("npm create b4-app@latest my-agent")
    expect(cli).toContain('let template = "basic"')
    // Regex, not a string: Biome's noTemplateCurlyInString rejects "${…}" in plain strings.
    expect(cli).toMatch(/`✔ Created \$\{appName\} \(\$\{options\.template\} template\)`/)
    expect(scaffoldTree.created).toBe(`Created ${appName} (basic template)`)
    expect(scaffoldTree.root).toBe(`${appName}/`)
  })

  it("ends on the next steps create-b4-app prints for the basic template", () => {
    expect(cli).toMatch(/ {2}cd \$\{targetDir\}/)
    expect(cli).toContain('"  npm install"')
    expect(cli).toMatch(/"  npm test\s+# offline tests/)
    expect(scaffoldTree.next).toBe(`cd ${appName} && npm install && npm test`)
  })

  it("links exactly one entry, the agent folder, to the first-agent section", () => {
    const linked = flatten(scaffoldTree.entries).filter((entry) => entry.href !== undefined)
    expect(linked.map((entry) => [entry.path, entry.href])).toEqual([["src/app/hello", "#first-agent"]])
  })
})

describe("layoutTree", () => {
  it("draws box glyphs and numbers rows in reading order after the lines above", () => {
    const { rows, next } = layoutTree(scaffoldTree.entries, 3)
    expect(rows.map((row) => row.glyph)).toEqual(["├─ ", "├─ ", "├─ ", "└─ "])
    const hello = rows[2]
    expect(hello?.label).toBe("src/app/hello/")
    expect(hello?.children.map((row) => row.glyph)).toEqual(["│  ├─ ", "│  ├─ ", "│  └─ "])
    const orders = rows.flatMap((row) => [row.order, ...row.children.map((child) => child.order)])
    expect(orders).toEqual([3, 4, 5, 6, 7, 8, 9])
    expect(next).toBe(10)
  })

  it("indents under a last entry with spaces, not a rule", () => {
    const { rows } = layoutTree(
      [{ label: "a/", path: "a", note: "", children: [{ label: "b", path: "a/b", note: "" }] }],
      0,
    )
    expect(rows[0]?.children[0]?.glyph).toBe("   └─ ")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/scaffold-tree.test.ts`
Expected: FAIL, with the error that `./scaffold-tree` cannot be resolved.

- [ ] **Step 3: Write the data**

Create `apps/web/app/components/homepage/scaffold-tree.json`:

```json
{
  "command": "npm create b4-app@latest my-agent",
  "created": "Created my-agent (basic template)",
  "root": "my-agent/",
  "entries": [
    { "label": "AGENTS.md", "path": "AGENTS.md", "note": "guide for your coding agent" },
    { "label": "b4.config.ts", "path": "b4.config.ts", "note": "runtime" },
    {
      "label": "src/app/hello/",
      "path": "src/app/hello",
      "note": "the agent",
      "href": "#first-agent",
      "children": [
        { "label": "index.ts", "path": "src/app/hello/index.ts", "note": "model + prompt" },
        { "label": "tools/greet.ts", "path": "src/app/hello/tools/greet.ts", "note": "a typed tool" },
        {
          "label": "evals/smoke.eval.ts",
          "path": "src/app/hello/evals/smoke.eval.ts",
          "note": "behavior check"
        }
      ]
    },
    { "label": "test/agent.test.ts", "path": "test/agent.test.ts", "note": "passes offline, no key" }
  ],
  "next": "cd my-agent && npm install && npm test"
}
```

- [ ] **Step 4: Write the accessor and layout**

Create `apps/web/app/components/homepage/scaffold-tree.ts`:

```ts
import "server-only"
import data from "./scaffold-tree.json"

export interface ScaffoldEntry {
  readonly label: string
  /** Relative to the basic template's root; the test checks it ships. */
  readonly path: string
  readonly note: string
  readonly href?: string
  readonly children?: readonly ScaffoldEntry[]
}

export interface ScaffoldTree {
  readonly command: string
  /** Printed after "✔ ", exactly as create-b4-app prints it. */
  readonly created: string
  readonly root: string
  readonly entries: readonly ScaffoldEntry[]
  readonly next: string
}

export interface TreeRow {
  readonly label: string
  readonly note: string
  readonly href?: string
  /** Box-drawing prefix, e.g. "│  ├─ ". */
  readonly glyph: string
  /** Position in the terminal's reveal sequence. */
  readonly order: number
  readonly children: readonly TreeRow[]
}

/** What `npm create b4-app@latest my-agent` scaffolds, as the homepage hero shows it. */
export const scaffoldTree: ScaffoldTree = data

/**
 * Lays entries out as terminal rows: box-drawing glyphs, and a reveal order
 * that continues from `start` (the lines above the tree take 0…start-1).
 * Returns the order after the last row.
 */
export function layoutTree(
  entries: readonly ScaffoldEntry[],
  start: number,
): { readonly rows: readonly TreeRow[]; readonly next: number } {
  let order = start
  const walk = (list: readonly ScaffoldEntry[], prefix: string): TreeRow[] =>
    list.map((entry, index) => {
      const last = index === list.length - 1
      const own = order++
      return {
        label: entry.label,
        note: entry.note,
        ...(entry.href !== undefined ? { href: entry.href } : {}),
        glyph: `${prefix}${last ? "└─ " : "├─ "}`,
        order: own,
        children: walk(entry.children ?? [], `${prefix}${last ? "   " : "│  "}`),
      }
    })
  const rows = walk(entries, "")
  return { rows, next: order }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/scaffold-tree.test.ts`
Expected: PASS (7 tests).

If `lists only files the basic template ships` fails, fix the JSON path. Do not loosen the test; the point is that it fails when the template changes.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/components/homepage/scaffold-tree.json apps/web/app/components/homepage/scaffold-tree.ts apps/web/app/components/homepage/scaffold-tree.test.ts
git commit -m "feat(web): scaffold tree data pinned to the basic template

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The ScaffoldTerminal component and its styles

**Files:**
- Create: `apps/web/app/components/homepage/ScaffoldTerminal.tsx`
- Create: `apps/web/app/components/homepage/scaffold-terminal.module.css`
- Test: `apps/web/app/components/homepage/homepage.test.tsx` (add one test)

- [ ] **Step 1: Write the failing test**

In `apps/web/app/components/homepage/homepage.test.tsx`, add this import next to the other local imports (keep them alphabetized; Biome sorts imports):

```ts
import { ScaffoldTerminal } from "./ScaffoldTerminal"
```

Append this test at the end of the file:

```ts
it("renders the scaffold as a captioned figure a screen reader can follow", () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(<ScaffoldTerminal />)
  const figure = container.querySelector("figure")
  expect(figure?.querySelector("figcaption")?.textContent).toBe("What npm create b4-app scaffolds")
  expect(figure?.textContent).toContain("npm create b4-app@latest my-agent")
  expect(figure?.textContent).toContain("Created my-agent (basic template)")
  expect(figure?.textContent).toContain("cd my-agent && npm install && npm test")
  expect(figure?.querySelector("ul")?.children).toHaveLength(4)
  expect(figure?.querySelectorAll("ul ul > li")).toHaveLength(3)
  // Glyphs, the marker and the arrow are decoration; labels and notes are text.
  for (const hidden of figure?.querySelectorAll('[aria-hidden="true"]') ?? []) {
    expect(hidden.textContent ?? "").toMatch(/^[\s│├└─$✔↓terminal]*$/)
  }
  const agent = figure?.querySelector<HTMLAnchorElement>('a[href="#first-agent"]')
  expect(agent?.textContent?.replace(/\s+/g, " ")).toContain("src/app/hello/")
  expect(agent?.textContent).toContain("the agent")
  // Every row's --i is unique, so no two lines appear at once.
  // Read the attribute: jsdom's CSSStyleDeclaration is unreliable for custom properties.
  const orders = [...(figure?.querySelectorAll("[style*='--i']") ?? [])].map(
    (node) => node.getAttribute("style")?.match(/--i:\s*(\d+)/)?.[1],
  )
  expect(new Set(orders).size).toBe(orders.length)
  expect(orders).toHaveLength(10)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/homepage.test.tsx`
Expected: FAIL, with the error that `./ScaffoldTerminal` cannot be resolved.

- [ ] **Step 3: Write the component**

Create `apps/web/app/components/homepage/ScaffoldTerminal.tsx`:

```tsx
import type { CSSProperties } from "react"
import { layoutTree, scaffoldTree, type TreeRow } from "./scaffold-tree"
import styles from "./scaffold-terminal.module.css"

/** The reveal slot a line takes; scaffold-terminal.module.css turns it into a delay. */
const slot = (order: number) => ({ "--i": order }) as CSSProperties

function Row({ row }: { row: TreeRow }) {
  const content = (
    <>
      <span className={styles.file}>
        <span className={styles.glyph} aria-hidden="true">
          {row.glyph}
        </span>
        {row.href !== undefined ? <span className={styles.marker} aria-hidden="true" /> : null}
        {row.label}
      </span>
      <span className="sr-only">, </span>
      <span className={styles.note}>
        {row.note}
        {row.href !== undefined ? <span aria-hidden="true"> ↓</span> : null}
      </span>
    </>
  )
  return row.href !== undefined ? (
    <a href={row.href} className={[styles.row, styles.agent].join(" ")}>
      {content}
    </a>
  ) : (
    <span className={styles.row}>{content}</span>
  )
}

function Rows({ rows }: { rows: readonly TreeRow[] }) {
  return (
    <ul className={styles.tree}>
      {rows.map((row) => (
        <li key={row.label} className={styles.line} style={slot(row.order)}>
          <Row row={row} />
          {row.children.length > 0 ? <Rows rows={row.children} /> : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * What `npm create b4-app` scaffolds, as a terminal. Server-rendered in its
 * final layout; the line-by-line reveal is CSS only and skipped under
 * reduced motion.
 */
export function ScaffoldTerminal() {
  const { command, created, root, entries, next } = scaffoldTree
  const tree = layoutTree(entries, 3)
  return (
    <figure className={styles.terminal} style={{ "--last": tree.next } as CSSProperties}>
      <figcaption className="sr-only">What npm create b4-app scaffolds</figcaption>
      <div className={styles.strip} aria-hidden="true">
        terminal
      </div>
      <div className={styles.body}>
        <p className={styles.line} style={slot(0)}>
          <span className={styles.prompt} aria-hidden="true">
            ${" "}
          </span>
          {command}
        </p>
        <p className={[styles.line, styles.created].join(" ")} style={slot(1)}>
          <span className={styles.prompt} aria-hidden="true">
            ✔{" "}
          </span>
          {created}
        </p>
        <p className={styles.line} style={slot(2)}>
          {root}
        </p>
        <Rows rows={tree.rows} />
      </div>
      <p className={styles.next}>
        <span className={styles.prompt} aria-hidden="true">
          ${" "}
        </span>
        {next}
      </p>
    </figure>
  )
}
```

Note the slot count: the command, created and root lines take 0–2, and the 7 tree rows take 3–9, so the test expects 10 `--i` values. `--last` is 10.

- [ ] **Step 4: Write the styles**

Create `apps/web/app/components/homepage/scaffold-terminal.module.css`:

```css
/* The hero's scaffold terminal. Dark-panel tokens only (tokens.css). */
.terminal {
  /* The global focus ring is tuned for paper; on the panel it uses the accent. */
  --color-focus: var(--color-panel-accent);
  position: relative;
  margin: 0;
  background: var(--color-panel);
  color: var(--color-panel-ink);
  font:
    13px / 1.75 var(--font-mono),
    monospace;
}
.strip {
  padding: 10px 18px;
  background: var(--color-panel-strip);
  color: var(--color-panel-muted);
  font-size: 12px;
}
.body {
  padding: 18px 18px 20px;
}
.body p {
  margin: 0;
}
.prompt {
  color: var(--color-panel-accent);
}
/* A blank terminal line between the command's output and the tree
   (two classes, so it outranks `.body p`). */
.body .created {
  margin-bottom: 1.75em;
}
.tree {
  list-style: none;
  margin: 0;
  padding: 0;
}
.row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}
.file {
  white-space: pre;
}
.note {
  color: var(--color-panel-dim);
  text-align: right;
}
/* The agent folder: the one row that is a link, marked by the Relay dot. */
.agent {
  margin-inline: -18px;
  padding: 2px 18px 2px 16px;
  border-left: 2px solid var(--color-panel-accent);
  background: color-mix(in srgb, var(--color-panel-accent) 14%, var(--color-panel));
  color: var(--color-panel-ink);
  text-decoration: none;
}
.agent .note {
  color: var(--color-panel-accent);
}
.agent:hover .file,
.agent:focus-visible .file {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.marker {
  display: inline-block;
  width: 0.6em;
  height: 0.6em;
  margin-right: 0.5em;
  border-radius: 50%;
  background: var(--color-panel-accent);
}
.next {
  margin: 0;
  padding: 10px 18px;
  border-top: 1px solid var(--color-panel-rule);
  background: var(--color-panel-strip);
  color: var(--color-panel-muted);
  overflow-wrap: anywhere;
}

/* Narrow screens: each note drops under its file, indented past the glyphs. */
@media (max-width: 479px) {
  .row {
    flex-direction: column;
    gap: 0;
  }
  .note {
    padding-left: 3ch;
    text-align: left;
  }
  .tree .tree .note {
    padding-left: 6ch;
  }
}

/* The reveal: one pass, about 1s. Lines are already in place, so only opacity
   and a 4px lift move (no layout shift). Reduced motion gets the final frame. */
@media (prefers-reduced-motion: no-preference) {
  .line {
    animation: terminal-line 300ms cubic-bezier(0.22, 1, 0.36, 1) calc(var(--i) * 60ms + 120ms) both;
  }
  .agent {
    animation: agent-row 400ms ease-out calc(var(--last) * 60ms + 180ms) both;
  }
  .agent .marker {
    animation: agent-marker 300ms cubic-bezier(0.34, 1.56, 0.64, 1) calc(var(--last) * 60ms + 180ms)
      both;
  }
}
@keyframes terminal-line {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}
@keyframes agent-row {
  from {
    background-color: var(--color-panel);
    border-left-color: transparent;
  }
}
@keyframes agent-marker {
  from {
    transform: scale(0);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/ app/styles/design-system.test.ts`
Expected: PASS, including the design-system guard. If the guard flags `color-mix(`, stop and report: the guard does not list it today (it bans `rgba(`, `hsl(`, `oklch(`, and named colours), but don't widen the guard.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/components/homepage/ScaffoldTerminal.tsx apps/web/app/components/homepage/scaffold-terminal.module.css apps/web/app/components/homepage/homepage.test.tsx
git commit -m "feat(web): a scaffold terminal component with a CSS-only reveal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The two-column hero, the LangGraph line, and the eclipse

**Files:**
- Modify: `apps/web/app/components/homepage/DeveloperHome.tsx`
- Modify: `apps/web/app/components/homepage/homepage.module.css`
- Test: `apps/web/app/components/homepage/homepage.test.tsx`

- [ ] **Step 1: Write the failing test**

In `homepage.test.tsx`, add this test after the first `it(...)`:

```ts
it("shows the runtime and what the command creates beside the headline", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  const hero = container.querySelector('[aria-labelledby="home-title"]')
  expect(hero?.textContent).toContain("Runs on LangGraph.js. You keep the graph.")
  const figure = hero?.querySelector("figure")
  expect(figure?.querySelector("figcaption")?.textContent).toBe("What npm create b4-app scaffolds")
  // The tree's agent row points at the section that opens those files.
  expect(figure?.querySelector('a[href="#first-agent"]')).not.toBeNull()
  expect(container.querySelector("#first-agent")).not.toBeNull()
  // The old dot hung directly off the hero; decoration now lives beside the terminal.
  expect(hero?.querySelectorAll(':scope > [aria-hidden="true"]')).toHaveLength(0)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/homepage.test.tsx`
Expected: FAIL on `toContain("Runs on LangGraph.js. You keep the graph.")`.

- [ ] **Step 3: Update DeveloperHome**

In `apps/web/app/components/homepage/DeveloperHome.tsx`:

Replace the `createCommand` constant, and add the two imports (keep Biome's import order):

```tsx
import { ScaffoldTerminal } from "./ScaffoldTerminal"
import { scaffoldTree } from "./scaffold-tree"
```

```tsx
const createCommand = scaffoldTree.command
```

Replace the whole `<section className={styles.hero} …>…</section>` with:

```tsx
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
```

- [ ] **Step 4: Update the hero CSS**

In `apps/web/app/components/homepage/homepage.module.css`:

4a. Add `overflow: clip;` to `.home`, with this comment above the property:

```css
.home {
  background: var(--color-page);
  color: var(--color-ink);
  font-family: var(--font-sans);
  padding: 0 40px 72px;
  /* The hero's eclipse crops at the page edge and under the header. `clip`
     is not a scroll container, so nothing inside becomes scrollable. */
  overflow: clip;
}
```

4b. Replace the rules from `.hero {` through the `.dot {…}` block. That covers `.hero`, `.eyebrow`, `.hero h1`, `.hero > p:last-of-type`, the eyebrow comment, `.hero > .eyebrow`, `.home h1…`, `.home p`, the `.heroActions` comment, `.heroActions`, the command comment, `.home .command`, and `.dot`. Replace them with:

```css
/* Copy left, the scaffold terminal right; stacked below 960px. */
.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  gap: 48px;
  align-items: start;
  padding: 64px 0 44px;
  position: relative;
}
.heroCopy {
  min-width: 0;
  position: relative;
  z-index: 1;
}
.eyebrow {
  margin: 0;
}
/* Sized so each headline line fits the copy column at every desktop width. */
.hero h1 {
  font-size: clamp(44px, 4.8vw, 68px);
  line-height: 1.03;
  letter-spacing: -0.055em;
  font-weight: 600;
  margin: 20px 0 24px;
}
.lede {
  font-size: 19px;
  line-height: 1.65;
  max-width: 550px;
  margin: 0;
}
.runtime {
  margin: 12px 0 0;
  font-size: 15px;
  font-weight: 500;
  color: var(--color-olive);
}
/* The eyebrow stays on one line in both the fallback and the loaded mono font,
   so the font swap never shifts the hero. */
.heroCopy > .eyebrow {
  white-space: nowrap;
}
.home h1,
.home h2,
.home h3 {
  text-wrap: balance;
}
.home p {
  text-wrap: pretty;
}
/* Stacked, so the link never moves when the command's mono font swaps in. */
.heroActions {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  margin-top: 32px;
}
/* One line at every width, so the font swap cannot change the hero's height. */
.home .command {
  max-width: 100%;
  font-size: 13px;
  white-space: nowrap;
}
/* Top-aligned with the headline (eyebrow + its margin). */
.heroVisual {
  position: relative;
  min-width: 0;
  margin-top: 40px;
}
/* The signature dot, as an eclipse behind the terminal's top-right corner.
   Decorative; `.home` crops it at the page edge. Never behind text: it sits
   entirely inside the terminal column's corner. */
.eclipse {
  position: absolute;
  top: -220px;
  right: -220px;
  width: 440px;
  height: 440px;
  border-radius: 50%;
  background: var(--color-relay);
  pointer-events: none;
}
/* The same dot, small and outlined (relay on paper is 1.6:1), marking the
   section the terminal's agent row links to. */
.markerDot {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 10px;
  border: 1.5px solid var(--color-ink);
  border-radius: 50%;
  background: var(--color-relay);
  vertical-align: -1px;
}
@media (max-width: 959px) {
  .hero {
    grid-template-columns: minmax(0, 1fr);
    row-gap: 72px;
  }
  .heroVisual {
    margin-top: 0;
  }
  /* 60px overshoot above the terminal stays inside the 72px row gap. */
  .eclipse {
    top: -60px;
    right: -60px;
    width: 200px;
    height: 200px;
  }
}
```

4c. In the `@media (max-width: 760px)` block, delete:

```css
  .dot {
    display: none;
  }
```

4d. In the `@media (max-width: 430px)` block, replace the `.hero > p:last-of-type {` selector with `.lede {`, keeping its `font-size: 17px;`.

4e. Check that nothing else still uses the old selectors:

Run: `grep -n "\.dot\b\|p:last-of-type\|\.hero > " apps/web/app/components/homepage/homepage.module.css`
Expected: no output.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/ app/styles/design-system.test.ts`
Expected: PASS. The existing "opens with the install command…" test still passes, because the hero still contains the command and the Get started link.

- [ ] **Step 6: Commit**

```bash
git status --short   # restore/delete apps/web/AGENTS.md, CLAUDE.md, next-env.d.ts if next dev touched them
git add apps/web/app/components/homepage/DeveloperHome.tsx apps/web/app/components/homepage/homepage.module.css apps/web/app/components/homepage/homepage.test.tsx
git commit -m "feat(web): hero shows what the scaffold creates, beside the Relay eclipse

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The marker dot on "Your first agent"

**Files:**
- Modify: `apps/web/app/components/homepage/FirstAgent.tsx`
- Test: `apps/web/app/components/homepage/homepage.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `homepage.test.tsx`:

```ts
it("marks the first-agent section with the dot the terminal's agent row carries", async () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(await DeveloperHome())
  const eyebrow = container.querySelector('#first-agent [data-ui="eyebrow"]')
  expect(eyebrow?.textContent).toBe("Your first agent")
  expect(eyebrow?.querySelector('span[aria-hidden="true"]')).not.toBeNull()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/homepage.test.tsx`
Expected: FAIL on `querySelector('span[aria-hidden="true"]')` being `null`.

- [ ] **Step 3: Add the marker**

In `apps/web/app/components/homepage/FirstAgent.tsx`, replace:

```tsx
        <Eyebrow className={styles.eyebrow}>Your first agent</Eyebrow>
```

with:

```tsx
        <Eyebrow className={styles.eyebrow}>
          <span className={styles.markerDot} aria-hidden="true" />
          Your first agent
        </Eyebrow>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --dir apps/web exec vitest --run --config vitest.config.ts app/components/homepage/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/homepage/FirstAgent.tsx apps/web/app/components/homepage/homepage.test.tsx
git commit -m "feat(web): the first-agent section carries the terminal's marker dot

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Gates

**Files:** none new.

- [ ] **Step 1: Lint**

Run: `pnpm --dir apps/web lint`
Expected: exit 0. If Biome reports formatting, run `pnpm --dir apps/web exec biome check --write --config-path ../../packages/config-biome/biome.json --css-parse-tailwind-directives=true app/components/homepage`. That's scoped to the homepage folder; never run bare `biome check --write`.

- [ ] **Step 2: Typecheck**

Run: `pnpm --dir apps/web typecheck`
Expected: exit 0. A fresh worktree needs the `@b4run/*` packages built first (`pnpm build` from the root) if the typecheck can't resolve them.

- [ ] **Step 3: The full web suite**

Run: `pnpm --dir apps/web test`
Expected: all pass. Don't pipe it through `tail`; that hides the exit code.

- [ ] **Step 4: Commit any lint fixes**

```bash
git status --short
git add apps/web/app/components/homepage
git commit -m "style(web): format the scaffold hero

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Skip this commit if nothing changed.

---

### Task 6: Visual, motion, and accessibility verification, then lastmod

**Files:**
- Create (scratchpad only, not committed): `<scratchpad>/verify-hero.mjs`
- Modify: `apps/web/app/seo/lastmod.generated.json`

- [ ] **Step 1: Start the dev server**

Use the `web` configuration in `.claude/launch.json` (`pnpm --dir apps/web dev --port 3217`) through `preview_start`, or run it in the background. Wait for `http://localhost:3217/` to return 200.

- [ ] **Step 2: Write the verification script**

Find axe: `find ~/repos/ag-ui -path '*axe-core@4.11.0*' -name axe.min.js | head -1`. If there's no result, use `find / -name axe.min.js -path '*axe-core*' 2>/dev/null | head -1`.

Create `<scratchpad>/verify-hero.mjs`, using `playwright-core` from the repo's `node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core` and Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`:

```js
import { readFileSync } from "node:fs"
import { chromium } from "/Users/blove/repos/dawn/.claude/worktrees/zen-curie-dd3701/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.mjs"

const AXE = process.argv[2]
const OUT = process.argv[3]
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
})
const results = []
for (const [width, height] of [[375, 812], [768, 1024], [1024, 768], [1440, 900]]) {
  for (const reducedMotion of ["no-preference", "reduce"]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion })
    await page.goto("http://localhost:3217/", { waitUntil: "networkidle" })
    await page.waitForTimeout(1500) // past the ~1s reveal
    const facts = await page.evaluate(() => {
      const h1 = document.querySelector("#home-title")
      const lineHeight = Number.parseFloat(getComputedStyle(h1).lineHeight)
      const agent = document.querySelector('a[href="#first-agent"]')
      const line = document.querySelector("figure li")
      return {
        horizontalScroll: document.documentElement.scrollWidth > innerWidth,
        h1Lines: Math.round(h1.getBoundingClientRect().height / lineHeight),
        agentRowHeight: agent?.getBoundingClientRect().height,
        lineAnimation: line ? getComputedStyle(line).animationName : null,
        lineOpacity: line ? getComputedStyle(line).opacity : null,
      }
    })
    await page.screenshot({ path: `${OUT}/hero-${width}-${reducedMotion}.png` })
    if (reducedMotion === "no-preference") {
      await page.addScriptTag({ content: readFileSync(AXE, "utf8") })
      const axe = await page.evaluate(async () => {
        const r = await window.axe.run(document, { resultTypes: ["violations"] })
        return r.violations.map((v) => `${v.id} (${v.nodes.length})`)
      })
      facts.axe = axe
    }
    results.push({ width, reducedMotion, ...facts })
    await page.close()
  }
}
await browser.close()
console.log(JSON.stringify(results, null, 2))
```

- [ ] **Step 3: Run it and check every fact**

Run: `node <scratchpad>/verify-hero.mjs "<axe path>" "<scratchpad>"`

Expected, for every row:
- `horizontalScroll: false`
- `h1Lines: 2` ("Ridiculous speed." and "Readable code." each on one line). At 375px, 3 lines is acceptable only if the page did that before the change. Check the pre-change screenshot: the old 375px hero was 2 lines.
- `agentRowHeight` ≥ 24 (WCAG 2.5.8 minimum target)
- `lineOpacity: "1"` (after the reveal)
- `lineAnimation` is `"none"` when `reducedMotion: "reduce"`, and a hashed `terminal-line` name otherwise
- `axe`: no violations in rules that touch the hero. Compare against a run on `main` if anything unrelated shows up.

- [ ] **Step 4: Look at the screenshots**

Open each `hero-*.png` with the Read tool and check:
- The eclipse never sits behind text: not the H1, the lede, the runtime line or the copy command. At 375 and 768px it sits in the gap above the terminal and behind its corner.
- The eclipse crops at the page's right edge (and under the header at ≥ 960px), with no hard vertical cut inside the page.
- The terminal's notes line up at ≥ 480px and drop under their file names at 375px, with nothing clipped.
- Below the hero, the chapters and walkthrough look unchanged. Scroll one screenshot per breakpoint down to the takeaway (`page.locator('[aria-labelledby="run-title"]').screenshot(...)`) to confirm `.home { overflow: clip }` clipped nothing.
- Contrast: the agent row's accent note on its tint stays readable (axe checks this).

Fix anything that fails, rerun Task 5, and commit the fixes with a message naming the defect.

- [ ] **Step 5: Stop the dev server and clean up what it wrote**

Stop the server. Then run `git status --short` and delete or restore `apps/web/AGENTS.md`, `apps/web/CLAUDE.md` and `apps/web/next-env.d.ts` if they changed.

- [ ] **Step 6: Regenerate the SEO lastmod manifest**

Run: `pnpm --dir apps/web seo:lastmod`
Then: `git diff --stat apps/web/app/seo/lastmod.generated.json`
Expected: only the `/` route's entry changes.

```bash
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): regenerate lastmod for the homepage hero

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Final full check**

Run: `pnpm --dir apps/web test && pnpm --dir apps/web typecheck && pnpm --dir apps/web lint`
Expected: exit 0 for all three.
