import { gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { API_REFERENCE_PAGES } from "./api-reference-pages"
import {
  filterDocsSearchResults,
  flattenDocsSearchIndex,
  queryVariants,
} from "./docs-search-results"
import { ALL_DOCS_PAGES, DOCS_NAV } from "./nav"
import { DOCS_INDEX, extractSearchDocument, parsePublicExportAliases } from "./search-index"

const FINAL_PR2_API_HREFS = [
  "/docs/api/permissions",
  "/docs/api/workspace",
  "/docs/api/sandbox",
  "/docs/api/langgraph",
  "/docs/api/langchain",
  "/docs/api/sqlite-storage",
] as const

describe("documentation search index", () => {
  it("contains every registered page in exhaustive registry order", () => {
    const journeySectionByHref = new Map<string, string>(
      DOCS_NAV.flatMap((section) => section.items.map((item) => [item.href, section.label])),
    )
    const apiHrefs = new Set<string>(API_REFERENCE_PAGES.map(({ href }) => href))
    const expected = ALL_DOCS_PAGES.map((item) => ({
      href: item.href,
      title: item.label,
      section: apiHrefs.has(item.href) ? "API Reference" : journeySectionByHref.get(item.href),
    }))

    expect(DOCS_INDEX.map(({ href, title, section }) => ({ href, title, section }))).toEqual(
      expected,
    )
    expect(expected).toContainEqual({
      href: "/docs/recipes",
      title: "Recipes Overview",
      section: "Recipes",
    })
    expect(expected).toContainEqual({
      href: "/docs/memory/long-term",
      title: "Long-term Memory",
      section: "Memory",
    })
    expect(expected).toContainEqual({
      href: "/docs/testing-agents/fixtures",
      title: "Fixtures and Recording",
      section: "Test and Evaluate",
    })
    expect(expected).toContainEqual({
      href: "/docs/thread-access",
      title: "Thread Access",
      section: "Secure",
    })
    for (const page of API_REFERENCE_PAGES) {
      expect(expected).toContainEqual({
        href: page.href,
        title: page.label,
        section: "API Reference",
      })
    }
    expect(expected.filter(({ href }) => FINAL_PR2_API_HREFS.includes(href as never))).toEqual(
      FINAL_PR2_API_HREFS.map((href) => ({
        href,
        title: API_REFERENCE_PAGES.find((page) => page.href === href)?.label,
        section: "API Reference",
      })),
    )
  })

  it("maps exact package and subpath aliases to canonical hub or owner pages", () => {
    const results = flattenDocsSearchIndex(DOCS_INDEX)
    for (const href of FINAL_PR2_API_HREFS) {
      const packageName = API_REFERENCE_PAGES.find((page) => page.href === href)?.surfaceName
      expect(packageName).toBeDefined()
      expect(filterDocsSearchResults(packageName ?? "", results)[0]?.href).toBe(href)
    }
    expect(filterDocsSearchResults("@b4run/sdk/pure", results)[0]?.href).toBe("/docs/api/sdk")
    expect(filterDocsSearchResults("@b4run/config-typescript/nextjs", results)[0]?.href).toBe(
      "/docs/api",
    )
  })

  it("maps a table-only export to its canonical owner page", () => {
    const results = flattenDocsSearchIndex(DOCS_INDEX)
    expect(filterDocsSearchResults("fuseHybrid", results)[0]?.href).toBe("/docs/api/memory")
  })

  it.each([
    ["config", "/docs/api/core"],
    ["RuntimeEnv", "/docs/api/core"],
    ["seedB4Config", "/docs/api/core"],
  ])("ranks the canonical owner first for the exact %s re-export alias", (alias, href) => {
    const results = flattenDocsSearchIndex(DOCS_INDEX)
    const matches = filterDocsSearchResults(alias, results)
    expect(matches[0]?.href).toBe(href)
    expect(matches.map(({ href: matchHref }) => matchHref)).toContain("/docs/api/cli")
  })

  it("ranks exact aliases ahead of fuzzy text and preserves registry order for ties", () => {
    const results = flattenDocsSearchIndex([
      {
        href: "/docs/getting-started",
        title: "First page",
        section: "Reference",
        headings: [],
        sections: [],
        aliases: ["sharedAlias"],
        canonicalAliases: [],
        aliasSurfaces: {},
      },
      {
        href: "/docs/mental-model",
        title: "sharedAlias guide",
        section: "Reference",
        headings: [],
        sections: [],
        aliases: ["sharedAlias"],
        canonicalAliases: [],
        aliasSurfaces: {},
      },
    ])
    expect(filterDocsSearchResults("sharedAlias", results).map(({ href }) => href)).toEqual([
      "/docs/getting-started",
      "/docs/mental-model",
    ])
  })

  it.each([
    ["retry", "/docs/retry"],
    ["memory", "/docs/memory"],
    ["sandbox", "/docs/sandbox"],
    ["tools", "/docs/tools"],
  ])("ranks the %s guide above API-reference export aliases", (query, href) => {
    const results = flattenDocsSearchIndex(DOCS_INDEX)
    const matches = filterDocsSearchResults(query, results).map(({ href: match }) => match)
    expect(matches[0]).toBe(href)
    // No API reference page outranks the guide's own page row.
    const firstApi = matches.findIndex((match) => match.startsWith("/docs/api/"))
    expect(firstApi === -1 || firstApi > matches.indexOf(href)).toBe(true)
  })

  it("still finds an API page by an exact export name", () => {
    const results = flattenDocsSearchIndex(DOCS_INDEX)
    expect(filterDocsSearchResults("defineMemory", results)[0]?.href).toBe("/docs/api/sdk")
    expect(filterDocsSearchResults("SandboxConfig", results).map(({ href }) => href)).toContain(
      "/docs/api/sandbox",
    )
  })

  it("returns no results when neither visible text nor an alias matches", () => {
    const results = flattenDocsSearchIndex(DOCS_INDEX)
    expect(filterDocsSearchResults("definitely-no-such-doc-term", results)).toEqual([])
  })

  it("supports partial aliases and retains the empty-query result cap", () => {
    const results = flattenDocsSearchIndex(DOCS_INDEX)
    expect(filterDocsSearchResults("fuseHyb", results)[0]?.href).toBe("/docs/api/memory")
    expect(filterDocsSearchResults("", results)).toEqual(results.slice(0, 20))
    expect(filterDocsSearchResults("   ", results)).toEqual(results.slice(0, 20))
  })

  it("parses only exact visible Public exports ownership tables", () => {
    const source = `# Reference

<!--
## Public exports
### \`@b4run/ghost\`
| Export | Responsibility |
|---|---|
| \`Ghost\` | Ignore a comment. |
-->

\`\`\`md
## Public exports
### \`@b4run/fenced\`
| Export | Responsibility |
|---|---|
| \`Fenced\` | Ignore a fence. |
\`\`\`

~~~md
## Public exports
### \`@b4run/tilde-fenced\`
| Export | Responsibility |
|---|---|
| \`TildeFenced\` | Ignore a tilde fence. |
~~~

{/*
## Public exports
### \`@b4run/mdx-comment\`
| Export | Responsibility |
|---|---|
| \`MdxComment\` | Ignore an MDX comment. |
*/}

## Public exports

| Name | Value |
|---|---|
| \`ordinary\` | Ignore an unrelated table. |

### \`@b4run/example\`

| Export | Responsibility |
|---|---|
| \`owned\` | Canonical owner. |
| \`forwarded\` | Re-export [the owner](/docs/api/core#b4runcore). |

## Key contracts`

    expect(
      parsePublicExportAliases(source, "/docs/api/example", [
        { heading: "@b4run/example", firstHeader: "Export" },
      ]),
    ).toEqual({
      aliases: ["owned", "forwarded"],
      canonicalAliases: ["owned"],
      aliasSurfaces: { owned: "@b4run/example", forwarded: "@b4run/example" },
    })
  })

  it.each([
    ["missing", "# Reference\n\n## Key contracts"],
    [
      "malformed header",
      "# Reference\n\n## Public exports\n\n### `@b4run/example`\n\n| Name | Responsibility |\n|---|---|\n| `owned` | Owner. |\n\n## Key contracts",
    ],
    [
      "malformed row",
      "# Reference\n\n## Public exports\n\n### `@b4run/example`\n\n| Export | Responsibility |\n|---|---|\n| owned | Owner. |\n\n## Key contracts",
    ],
    [
      "table after the next heading",
      "# Reference\n\n## Public exports\n\n### `@b4run/example`\n\n### `bin:example`\n\n| Export | Responsibility |\n|---|---|\n| `owned` | Owner. |\n\n## Key contracts",
    ],
  ])("rejects a %s intended export inventory", (_name, source) => {
    expect(() =>
      parsePublicExportAliases(source, "/docs/api/example", [
        { heading: "@b4run/example", firstHeader: "Export" },
      ]),
    ).toThrow(/Public exports|ownership table|Export/i)
  })

  it("rejects an ownership table for a surface absent from the registry", () => {
    const source = `# Reference

## Public exports

### \`@b4run/example\`

| Export | Responsibility |
|---|---|
| \`owned\` | Owner. |

### \`@b4run/unregistered\`

| Export | Responsibility |
|---|---|
| \`extra\` | Not registered. |

## Key contracts`
    expect(() =>
      parsePublicExportAliases(source, "/docs/api/example", [
        { heading: "@b4run/example", firstHeader: "Export" },
      ]),
    ).toThrow(/unregistered surface/i)
  })

  it("parses generated ownership tables with their distinct header", () => {
    const source = `# Generated Route Types

## Public exports

### \`b4:routes\`

| Generated export | Responsibility |
|---|---|
| \`B4RoutePath\` | Generated route paths. |

## Key contracts`
    expect(
      parsePublicExportAliases(source, "/docs/api/generated-routes", [
        { heading: "b4:routes", firstHeader: "Generated export" },
      ]),
    ).toEqual({
      aliases: ["B4RoutePath"],
      canonicalAliases: ["B4RoutePath"],
      aliasSurfaces: { B4RoutePath: "b4:routes" },
    })
  })

  it("indexes each section's first paragraph and code-only identifiers", () => {
    const { headings, sections } = extractSearchDocument(`# Title

Intro with \`inline code\` and a [link](/docs/tools).

Second intro paragraph is indexed up to the cap.

<Callout
  prompt={\`hidden prompt text\`}
/>

## Configure **it**

First paragraph of the section.
| a | b |

\`\`\`ts
const store = createPermissionsStore({ mode })
\`\`\`

#### Deeper heading

Deeper text is part of the H2 section.
`)
    expect(headings.map(({ text, anchor }) => ({ text, anchor }))).toEqual([
      { text: "Title", anchor: "title" },
      { text: "Configure it", anchor: "configure-it" },
    ])
    expect(sections).toEqual([
      {
        anchor: null,
        text: "Intro with inline code and a link. Second intro paragraph is indexed up to the cap.",
        terms: [],
      },
      {
        anchor: "configure-it",
        text: "First paragraph of the section. a b Deeper heading Deeper text is part of the H2 section.",
        terms: ["createPermissionsStore"],
      },
    ])
  })

  it.each([
    ["retries", 5],
    ["jitter", 1],
    ["useAgent", 1],
    ["transient model failures", 1],
  ])("finds body-text matches for %s", (query, atLeast) => {
    const results = flattenDocsSearchIndex(DOCS_INDEX)
    const matches = filterDocsSearchResults(query, results)
    expect(matches.length).toBeGreaterThanOrEqual(atLeast)
  })

  it("finds a code identifier that only appears inside code blocks", () => {
    const results = flattenDocsSearchIndex(DOCS_INDEX)
    const codeOnly = DOCS_INDEX.flatMap((entry) => entry.sections.flatMap(({ terms }) => terms))
    const term = codeOnly.find(
      (candidate) =>
        !DOCS_INDEX.some((entry) =>
          [entry.title, ...entry.aliases, ...entry.headings.map(({ text }) => text)].some((value) =>
            value.toLowerCase().includes(candidate.toLowerCase()),
          ),
        ),
    )
    expect(term).toBeDefined()
    const [first] = filterDocsSearchResults(term ?? "", results)
    expect(first?.match).toEqual({ kind: "code", term })
  })

  it("names the export and package surface an API page matched through", () => {
    const results = flattenDocsSearchIndex(DOCS_INDEX)
    const [first] = filterDocsSearchResults("defineMemory", results)
    expect(first?.href).toBe("/docs/api/sdk")
    expect(first?.match).toEqual({ kind: "alias", alias: "defineMemory", surface: "@b4run/sdk" })
  })

  it("keeps a body snippet around the match for text-only hits", () => {
    const results = flattenDocsSearchIndex(DOCS_INDEX)
    const hit = filterDocsSearchResults("jitter", results).find(
      ({ match }) => match?.kind === "text",
    )
    expect(hit?.match).toMatchObject({ kind: "text", match: "jitter" })
  })

  it("never shows Markdown syntax in heading text", () => {
    for (const entry of DOCS_INDEX) {
      for (const heading of entry.headings) {
        expect(heading.text, `${entry.href}#${heading.anchor}`).not.toMatch(/^#|\]\(|\*\*|`/)
      }
    }
  })

  it("stays small enough to fetch on first open", () => {
    // Guard against indexing whole sections by accident: the lazily fetched
    // index was ~100 KB gzipped when body text was added.
    expect(gzipSync(JSON.stringify(DOCS_INDEX)).length).toBeLessThan(125_000)
  })
})

describe("query variants", () => {
  it.each([
    ["retries", ["retry"]],
    ["streaming", ["stream"]],
    ["patches", ["patch"]],
    ["tools", ["tool"]],
    ["access", []],
    ["two words", []],
  ])("stems %s", (query, expected) => {
    expect(queryVariants(query)).toEqual(expected)
  })

  it("ranks the Retry guide first for the plural", () => {
    const results = flattenDocsSearchIndex(DOCS_INDEX)
    expect(filterDocsSearchResults("retries", results)[0]?.href).toBe("/docs/retry")
  })
})
