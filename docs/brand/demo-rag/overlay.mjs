import { cp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"

/**
 * The compliance app is not a `create-b4-app` template: the capture scaffolds
 * the navlog template (the one with the Workbench web client) and turns it
 * into the compliance app here. Three steps, in order:
 *
 * 1. REMOVED: the navlog route, its tools, its flight libraries, its
 *    reference corpus and the tests and generated types that name them. The
 *    generic pieces stay (auth, thread access, read-only paths, the
 *    Workbench shell, memory review).
 * 2. `app/` is copied over the result: the compliance route, its checker
 *    subagent, `searchPlans` and `readSection`, the workspace, the Workbench's
 *    layout with a source reader, and its source page.
 * 3. EDITS: a few navlog words in shell files this take keeps whole. Each
 *    edit must match exactly `count` times, so a template change fails the
 *    capture instead of silently keeping a navlog word on screen.
 */
export const OVERLAY_ROOT = join(import.meta.dirname, "app")

export const REMOVED = Object.freeze([
  "server/src/app/navlog",
  "server/src/tools",
  ...["awc", "fpl", "geo-filter", "geo", "navlog", "poh-tables", "wind", "winds-aloft"].map(
    (name) => `server/src/lib/${name}.ts`,
  ),
  "server/workspace",
  ...[
    "awc",
    "corpus-sync",
    "file-flight-plan",
    "fpl",
    "geo",
    "navlog",
    "poh-tables",
    "quality-eval",
    "read-doc",
    "render-chart",
    "resolve-departure",
    "weather-tools",
    "wind",
    "winds-aloft",
    "workspace-guard",
  ].map((name) => `server/test/${name}.test.ts`),
  // Generated route and scenario types; `b4 dev` writes them again for this app.
  "server/.b4/b4.generated.d.ts",
  "server/.b4/scenarios.generated.d.ts",
  // Web tests of what the overlay replaces: the navlog layout (the overlay's
  // layout has its own test), the brief kit's sync with the removed navlog
  // eval, and the CopilotKit route's navlog response schema.
  "web/app/components/WorkbenchLayout.test.tsx",
  "web/app/brief/kit.test.ts",
  "web/app/api/copilotkit/[...path]/route.test.ts",
])

export const EDITS = Object.freeze([
  {
    file: "web/app/components/NavlogChat.tsx",
    from: '"Ask the planner…"',
    to: '"Ask about the plans…"',
    count: 1,
  },
  {
    file: "web/app/layout.tsx",
    from: 'title: "B4.run navlog — a C172N VFR flight planner"',
    to: 'title: "B4.run compliance — an emergency-plan assistant"',
    count: 1,
  },
  {
    file: "web/app/components/AppShell.tsx",
    from: '"The navlog agent is not registered"',
    to: '"The compliance agent is not registered"',
    count: 1,
  },
  // The shell tests that read the wordmark.
  {
    file: "web/app/components/AppShell.test.tsx",
    from: '"B4.run / navlog"',
    to: '"B4.run / plans"',
    count: 1,
  },
  {
    file: "web/app/components/ConnectScreen.test.tsx",
    from: '"/ navlog"',
    to: '"/ plans"',
    count: 1,
  },
])

/** Every file under `root`, relative to it, sorted. */
export async function listFiles(root, dir = root) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listFiles(root, path)))
    else out.push(relative(root, path))
  }
  return out.sort()
}

/** Applies `edit` to `text`, refusing a count other than the expected one. */
export function applyEdit(text, edit) {
  const found = text.split(edit.from).length - 1
  if (found !== edit.count) {
    throw new Error(
      `overlay edit of ${edit.file}: expected ${edit.count} of ${JSON.stringify(edit.from)}, found ${found}`,
    )
  }
  return text.replaceAll(edit.from, edit.to)
}

/** Turns a scaffolded navlog app at `appRoot` into the compliance app. Returns the copied files. */
export async function applyOverlay({ appRoot, overlayRoot = OVERLAY_ROOT }) {
  for (const path of REMOVED) await rm(join(appRoot, path), { recursive: true, force: true })
  await cp(overlayRoot, appRoot, { recursive: true })
  for (const edit of EDITS) {
    const path = join(appRoot, edit.file)
    await writeFile(path, applyEdit(await readFile(path, "utf8"), edit), "utf8")
  }
  return listFiles(overlayRoot)
}
