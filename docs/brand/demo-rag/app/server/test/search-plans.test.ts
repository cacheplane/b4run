import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { B4ToolContext } from "@b4run/sdk"
import { describe, expect, it } from "vitest"
import readSection, { display as readDisplay } from "../src/tools/readSection.ts"
import searchPlans, { display as searchDisplay } from "../src/tools/searchPlans.ts"

const WORKSPACE = join(import.meta.dirname, "../workspace")

/** The tools' context over the real workspace files. */
const ctx = {
  signal: new AbortController().signal,
  fs: {
    readFile: (path: string) => readFile(join(WORKSPACE, path), "utf8"),
    listDir: (path = ".") => readdir(join(WORKSPACE, path)),
  },
} as unknown as B4ToolContext

describe("searchPlans", () => {
  it("ranks the plan's communications section first and cites it as a linked chip", async () => {
    const hits = await searchPlans({ query: "Lakeview communications warning backup" }, ctx)
    expect(hits[0]).toMatchObject({
      path: "plans/sample-lakeview-county-eop.md",
      heading: "5. Communications",
    })
    expect(searchDisplay.sources(hits)[0]).toEqual({
      title: "Sample Lakeview County EOP · 5. Communications",
      href: "/sources/plans/sample-lakeview-county-eop.md#5-communications",
    })
  })
  it("finds the CPG 101 elements in the FEMA excerpts", async () => {
    const hits = await searchPlans({ query: "basic plan elements" }, ctx)
    expect(hits.map((hit) => hit.path)).toContain("fema/cpg-101-plan-elements.md")
  })
})

describe("readSection", () => {
  it("reads one section by its heading", async () => {
    const section = await readSection(
      { path: "plans/sample-lakeview-county-eop.md", heading: "7. Plan maintenance" },
      ctx,
    )
    expect(section.text).toContain("updates it as needed")
    expect(readDisplay.sources(section)).toHaveLength(1)
  })
  it("refuses paths outside fema/ and plans/", async () => {
    await expect(readSection({ path: "../b4.config.ts", heading: "x" }, ctx)).rejects.toThrow(
      /Expected a \.md path/,
    )
  })
})
