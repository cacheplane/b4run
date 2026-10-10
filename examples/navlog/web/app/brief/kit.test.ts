import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { briefJsonSchema } from "./kit"

// The server's quality eval sends this schema as its `responseSchema`. The
// server must not import the web app, so it keeps a JSON copy; this pins it.
const SERVER_COPY = new URL(
  "../../../server/src/app/navlog/evals/brief-schema.json",
  import.meta.url,
)

const NAMES = [
  "BottomLine",
  "RouteSummary",
  "WatchFor",
  "KeyNumbers",
  "Assumptions",
  "Citations",
  "Prose",
] as const

/** OpenAI strict mode: every object closed and fully required. */
function assertStrict(node: unknown, path = "$"): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => {
      assertStrict(child, `${path}[${i}]`)
    })
    return
  }
  if (node === null || typeof node !== "object") return
  const o = node as Record<string, unknown>
  if (o.type === "object" && o.properties !== undefined) {
    expect(o.additionalProperties, `${path} additionalProperties`).toBe(false)
    expect(new Set(o.required as string[]), `${path} required`).toEqual(
      new Set(Object.keys(o.properties as object)),
    )
  }
  for (const [key, value] of Object.entries(o)) assertStrict(value, `${path}.${key}`)
}

describe("brief kit", () => {
  test("names all seven components", () => {
    const text = JSON.stringify(briefJsonSchema)
    for (const name of NAMES) expect(text).toContain(name)
  })

  test("is OpenAI-strict", () => {
    assertStrict(briefJsonSchema)
  })

  test("wraps the answer as { ui: [{ <Component>: { props } }] }", () => {
    const ui = (briefJsonSchema.properties as Record<string, { items: { anyOf: unknown[] } }>).ui
    const tags = ui?.items.anyOf.map(
      (option) => Object.keys((option as { properties: object }).properties)[0],
    )
    expect(tags).toEqual([...NAMES])
    expect(briefJsonSchema.required).toEqual(["ui"])
  })

  test("models the optional props as required-nullable", () => {
    const text = JSON.stringify(briefJsonSchema)
    // `when` (WatchFor) and `unit` (KeyNumbers): a string or null, never absent.
    expect(text).toMatch(/"when":\{"anyOf":\[\{"type":"string"[^\]]*\{"type":"null"/)
    expect(text).toMatch(/"unit":\{"anyOf":\[\{"type":"string"[^\]]*\{"type":"null"/)
  })

  test("matches the copy the server's quality eval sends", () => {
    expect(JSON.parse(readFileSync(SERVER_COPY, "utf8"))).toEqual(briefJsonSchema)
  })
})
