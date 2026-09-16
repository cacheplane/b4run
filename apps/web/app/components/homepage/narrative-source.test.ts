import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { narrativeSource, prepareNarrative } from "./narrative-source"

const exampleRoot = fileURLToPath(
  new URL("../../../../../examples/code-fixer/server/", import.meta.url),
)

it("shows exact current example source, including the complete review tool", async () => {
  for (const source of Object.values(narrativeSource.sources)) {
    expect(source.text).toBe(readFileSync(resolve(exampleRoot, source.path), "utf8"))
  }
  const prepared = await prepareNarrative()
  expect(prepared.tool.raw).toBe(narrativeSource.sources.tool.text)
  expect(prepared.tool.raw).toContain("await inspectCandidate(ctx)")
  expect(prepared.tool.raw).toContain("await verifyChanges(")
  expect(prepared.tool.raw).not.toContain("return prepareReview(ctx)")
  for (const [key, snippet] of Object.entries(narrativeSource.snippets)) {
    const source = narrativeSource.sources[snippet.source as keyof typeof narrativeSource.sources]
    expect(prepared[key as keyof typeof prepared].url).toBe(
      `https://github.com/cacheplane/b4run/blob/${narrativeSource.sourceCommit}/examples/code-fixer/server/${source.path}#L${snippet.start}-L${snippet.end}`,
    )
    expect(prepared[key as keyof typeof prepared].raw).toBe(
      source.text
        .split("\n")
        .slice(snippet.start - 1, snippet.end)
        .join("\n"),
    )
  }
})
