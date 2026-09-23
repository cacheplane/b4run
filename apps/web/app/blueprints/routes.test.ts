import { describe, expect, it } from "vitest"
import { GET as itemGet } from "./[name]/route"
import { GET as catalogGet } from "./index.json/route"

describe("/blueprints/index.json", () => {
  it("returns the catalog as JSON with derived name/category and url", async () => {
    const res = catalogGet()
    expect(res.headers.get("content-type")).toContain("application/json")
    const catalog = (await res.json()) as Array<{ name: string; category: string; url: string }>
    expect(Array.isArray(catalog)).toBe(true)
    expect(catalog.find((c) => c.name === "code-fixer")).toMatchObject({
      name: "code-fixer",
      category: "agents",
      url: "https://b4.run/blueprints/code-fixer.md",
    })
    const otel = catalog.find((c) => c.name === "opentelemetry")
    expect(otel?.category).toBe("observability")
    expect(otel?.url).toBe("https://b4.run/blueprints/opentelemetry.md")
  })
})

describe("/blueprints/[name].md", () => {
  it("returns the markdown body (frontmatter stripped) for a known name", async () => {
    const res = await itemGet(new Request("https://x/blueprints/opentelemetry.md"), {
      params: Promise.resolve({ name: "opentelemetry.md" }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/markdown")
    const text = await res.text()
    expect(text).toMatch(/^#\s/m)
    expect(text).not.toContain("description:")
  })

  it("serves the revision-pinned code-fixer installation guide without frontmatter", async () => {
    const res = await itemGet(new Request("https://x/blueprints/code-fixer.md"), {
      params: Promise.resolve({ name: "code-fixer.md" }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/markdown")
    const text = await res.text()
    expect(text).toMatch(/^# Code-fixer/)
    expect(text).not.toMatch(/^---/)
    expect(text).not.toContain("source: official")
    expect(text).toContain("89b95af3eb660fda8a45b2b5527da6bf8a29ea8d")
    expect(text).toContain(
      "npm exec --yes --package=create-b4-app@0.11.0 -- create-b4-app <new-target> --template basic --dist-tag 0.11.0",
    )
    expect(text).toContain("src/app/hello/")
    expect(text).not.toContain("(public)")
    expect(text).not.toContain("0.10.0")
    expect(text).not.toContain("bfaf0c2b3030eebb572703c8f70f0e063593b1fa")
    expect(text).not.toContain("fixture-v1")
    expect(text).toContain("// b4-blueprint: code-fixer@1")
    expect(text).toContain(".dockerignore")
    expect(text).toContain("npm run test:sandbox")
    expect(text).toContain("GET /healthz")
    expect(text).not.toContain("0003db2802b718ed167c8266b09a2d00ae01a522")
    expect(text).not.toContain("GET /info")
    expect(text).toContain("sibling app")
  })

  it("404s for an unknown name", async () => {
    const res = await itemGet(new Request("https://x/blueprints/nope.md"), {
      params: Promise.resolve({ name: "nope.md" }),
    })
    expect(res.status).toBe(404)
  })
})
