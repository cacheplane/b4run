import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { evidence, sourceUrl } from "./evidence"
import { prepareHomepage } from "./highlight"
import {
  type QualifiedCapabilityKey,
  qualifiedExcerpt,
  qualifiedSource,
  qualifiedSourceUrl,
} from "./qualified-source"

const commit = "0003db2802b718ed167c8266b09a2d00ae01a522"
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const expectedSources = {
  workspace: {
    path: "src/fixtures/workspace.ts",
    sha256: "9a3c35870bcf3f357bcb0c16adce595389b82f570404bb37206814a57f5d9e94",
  },
  evals: {
    path: "src/app/fix/evals/repair.eval.ts",
    sha256: "0267cbcccbe9f6ead4806fe70aa61ea4b9ad196f69035e80b68553def50894cc",
  },
  agent: {
    path: "src/app/fix/index.ts",
    sha256: "edc5513ef60ca2961c1d8c105e06557b091a1395bcd7c0d8cf01f060ee4b4149",
  },
}
const excerpts = {
  workspace: { source: "workspace", start: 13, end: 31 },
  sandbox: { source: "workspace", start: 6, end: 11 },
  evals: { source: "evals", start: 5, end: 38 },
  approval: { source: "agent", start: 1, end: 22 },
} as const

describe("qualified homepage capability source", () => {
  it("pins the reviewed 0.8.32 source independently of embedded hashes", () => {
    expect(qualifiedSource.release).toBe("0.8.32")
    expect(qualifiedSource.sourceCommit).toBe(commit)
    expect(Object.keys(qualifiedSource.sources).sort()).toEqual(Object.keys(expectedSources).sort())
    for (const [key, expected] of Object.entries(expectedSources)) {
      const source = qualifiedSource.sources[key as keyof typeof expectedSources]
      expect(source.path).toBe(expected.path)
      expect(source.sha256).toBe(expected.sha256)
      expect(hash(source.text)).toBe(expected.sha256)
    }
  })

  it.each(Object.keys(excerpts) as QualifiedCapabilityKey[])(
    "keeps %s a contiguous excerpt with a pinned line link",
    (key) => {
      const expected = excerpts[key]
      const source = qualifiedSource.sources[expected.source]
      const snippet = qualifiedSource.snippets[key]
      expect(snippet).toMatchObject(expected)
      expect(qualifiedExcerpt(key)).toBe(
        source.text
          .split("\n")
          .slice(expected.start - 1, expected.end)
          .join("\n"),
      )
      expect(hash(qualifiedExcerpt(key))).toBe(snippet.sha256)
      expect(qualifiedSourceUrl(key)).toBe(
        `https://github.com/cacheplane/b4run/blob/${commit}/examples/code-fixer/server/${source.path}#L${expected.start}-L${expected.end}`,
      )
    },
  )

  it("prepares qualified capabilities while preserving the recorded walkthrough", async () => {
    const { walkthrough, capabilities } = await prepareHomepage()
    for (const key of ["agent", "config", "plan"] as const) {
      expect(walkthrough.files[key].raw).toBe(evidence.sources[key].text)
      expect(walkthrough.files[key].url).toBe(sourceUrl(evidence.sources[key].path))
    }
    expect(walkthrough.files.agent.fold).toEqual({ start: 8, end: 19 })
    expect(walkthrough.command).toBe(evidence.command)
    expect(walkthrough.visible).toEqual(evidence.visible)
    expect(walkthrough.independent).toEqual(evidence.independent)
    expect(qualifiedSource.sourceCommit).not.toBe(evidence.sourceCommit)
    expect(capabilities.map(({ key }) => key)).toEqual(Object.keys(excerpts))
    for (const capability of capabilities) {
      const key = capability.key as QualifiedCapabilityKey
      expect(capability.code.raw).toBe(qualifiedExcerpt(key))
      expect(capability.code.url).toBe(qualifiedSourceUrl(key))
      expect(capability.code.firstLine).toBe(excerpts[key].start)
      expect(capability.code.path).toContain("excerpt")
    }
    expect(capabilities[0]?.explanation).toMatch(/B4.*capture.*creat.*reconnect.*cleanup/i)
    expect(capabilities[2]?.explanation).toMatch(/app.*independent verification/i)
    expect(capabilities[3]?.explanation).toMatch(/runtime pauses before.*exportForReview/i)
    expect(qualifiedExcerpt("sandbox")).toContain('mode: "deny"')
    expect(qualifiedExcerpt("evals")).toContain("gate: gate.perScorer()")
    expect(qualifiedExcerpt("evals")).toContain('entry.name === "prepareReview"')
    expect(qualifiedExcerpt("approval")).toContain('tools: { approve: ["exportForReview"] }')
  })
})
