import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { notFound } from "next/navigation"

/**
 * The source a citation chip links to: one FEMA excerpt or county plan from
 * the server's workspace, each `##` section anchored by its slug, the cited
 * one (the URL's hash) highlighted. Without a path, the list of sources.
 */

export const dynamic = "force-dynamic"

/** The server's workspace: `next dev` runs in web/, beside server/. */
const WORKSPACE = join(process.cwd(), "../server/workspace")
const DIRS = ["fema", "plans"] as const

/** The server tools' anchor rule (`server/src/lib/sources.ts`). */
const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")

const STYLE = `
body { margin: 0; background: var(--wb-surface); }
.src { padding: 28px 32px 48px; font-size: 15px; line-height: 1.6; color: var(--wb-text); }
.src h1 { margin: 0 0 6px; font-size: 22px; line-height: 1.25; letter-spacing: -0.01em; }
.src .lede { margin: 0 0 18px; color: var(--wb-muted); font-size: 13px; }
.src section { margin: 0 -12px 6px; padding: 8px 12px; border-left: 3px solid transparent; border-radius: 6px; scroll-margin-top: 24px; }
.src section:target { background: color-mix(in srgb, var(--wb-accent) 9%, white); border-left-color: var(--wb-accent); }
.src h2 { margin: 0 0 4px; font-size: 15px; }
.src p { margin: 0; }
.src ul { margin: 0; padding: 0; list-style: none; }
.src li { padding: 10px 0; border-bottom: 1px solid var(--wb-border); }
.src a { color: var(--wb-accent); text-decoration: none; font-weight: 600; }
`

async function listSources() {
  const docs: { path: string; title: string }[] = []
  for (const dir of DIRS) {
    for (const file of (await readdir(join(WORKSPACE, dir)))
      .filter((f) => f.endsWith(".md"))
      .sort()) {
      const text = await readFile(join(WORKSPACE, dir, file), "utf8")
      docs.push({ path: `${dir}/${file}`, title: /^# (.+)$/mu.exec(text)?.[1] ?? file })
    }
  }
  return docs
}

export default async function SourcePage({
  params,
}: {
  readonly params: Promise<{ readonly path?: readonly string[] }>
}) {
  const { path = [] } = await params
  if (path.length === 0) {
    const docs = await listSources()
    return (
      <main className="src" aria-label="Sources">
        <style>{STYLE}</style>
        <h1>Sources</h1>
        <p className="lede">
          FEMA CPG 101 excerpts and the sample county plans this assistant searches.
        </p>
        <ul>
          {docs.map((doc) => (
            <li key={doc.path}>
              <a href={`/sources/${doc.path}`}>{doc.title}</a>
            </li>
          ))}
        </ul>
      </main>
    )
  }
  const relative = path.join("/")
  if (
    path.length !== 2 ||
    !DIRS.some((dir) => dir === path[0]) ||
    !relative.endsWith(".md") ||
    relative.includes("..")
  ) {
    notFound()
  }
  let text: string
  try {
    text = await readFile(join(WORKSPACE, relative), "utf8")
  } catch {
    notFound()
  }
  const title = /^# (.+)$/mu.exec(text)?.[1] ?? relative
  const [intro = "", ...parts] = text.split(/^## /mu)
  const lede = intro
    .replace(/^# .+$/mu, "")
    .replace(/\s+/gu, " ")
    .trim()
  return (
    <main className="src" aria-label={title}>
      <style>{STYLE}</style>
      <h1>{title}</h1>
      <p className="lede">{lede}</p>
      {parts.map((part) => {
        const [heading = "", ...body] = part.split("\n")
        return (
          <section key={heading} id={slug(heading)}>
            <h2>{heading.trim()}</h2>
            <p>{body.join(" ").replace(/\s+/gu, " ").trim()}</p>
          </section>
        )
      })}
    </main>
  )
}
