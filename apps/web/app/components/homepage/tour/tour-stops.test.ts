import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { DOCS_INDEX } from "../../docs/search-index"
import { scaffoldTree } from "../scaffold-tree"
import { tourSources } from "./tour-sources"
import { TOUR_ROOT, tourStops } from "./tour-stops"

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url))

describe("the folder tour shows real files", () => {
  it("walks the hello agent's seven files in order", () => {
    expect(tourStops.map((stop) => [stop.file, stop.state])).toEqual([
      ["index.ts", "scaffolded"],
      ["tools/greet.ts", "scaffolded"],
      ["plan.md", "added"],
      ["memory.ts", "added"],
      ["skills/greetings/SKILL.md", "added"],
      ["subagents/translator/index.ts", "added"],
      ["evals/smoke.eval.ts", "scaffolded"],
    ])
  })

  it("shows each file exactly as it is on disk", () => {
    for (const stop of tourStops) {
      expect(tourSources[stop.id], stop.origin).toBe(
        readFileSync(resolve(repoRoot, stop.origin), "utf8"),
      )
    }
  })

  it("takes the scaffolded files from the basic template, as the hero's tree lists them", () => {
    const hello = scaffoldTree.entries.find((entry) => entry.path === "src/app/hello")
    const scaffolded = tourStops.filter((stop) => stop.state === "scaffolded")
    expect(scaffolded.map((stop) => `${TOUR_ROOT}${stop.file}`)).toEqual(
      hello?.children?.map((child) => child.path),
    )
    for (const stop of scaffolded) {
      expect(stop.origin.replace(/\.template$/, "")).toBe(
        `packages/devkit/templates/app-basic/${TOUR_ROOT}${stop.file}`,
      )
    }
  })

  it("keeps the added files as fixtures the web typecheck covers", () => {
    for (const stop of tourStops.filter((candidate) => candidate.state === "added")) {
      expect(stop.origin).toBe(`apps/web/app/components/homepage/tour/fixtures/hello/${stop.file}`)
    }
    // `pnpm --dir apps/web typecheck` compiles every .ts under apps/web, fixtures included,
    // against @b4run/sdk and zod. Keep it that way.
    const tsconfig = JSON.parse(readFileSync(resolve(repoRoot, "apps/web/tsconfig.json"), "utf8"))
    expect(tsconfig.include).toContain("**/*.ts")
    expect(tsconfig.exclude).toEqual(["node_modules"])
  })

  it("says each thing in two sentences, without an em dash", () => {
    for (const stop of tourStops) {
      expect(stop.copy.match(/[.!?](?=\s|$)/g), stop.id).toHaveLength(2)
      expect(`${stop.title} ${stop.copy}`, stop.id).not.toContain("—")
    }
  })

  it("links every stop to a docs heading that exists", () => {
    for (const stop of tourStops) {
      const [path, anchor] = stop.docsHref.split("#")
      const page = DOCS_INDEX.find((entry) => entry.href === path)
      expect(page, stop.docsHref).toBeDefined()
      expect(anchor, stop.docsHref).toBeTruthy()
      expect(
        page?.headings.map((heading) => heading.anchor),
        stop.docsHref,
      ).toContain(anchor)
    }
  })
})
